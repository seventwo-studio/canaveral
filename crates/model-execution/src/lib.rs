//! Owned, non-streaming Ollama execution. No runtime installation or capacity discovery.
#![cfg(unix)]
use canaveral_execution_core::model_job::{
    Cleanup, GenerationResult, Message, ModelJob, State, Usage,
};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    net::TcpListener,
    os::unix::{
        fs::{OpenOptionsExt, PermissionsExt},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::Duration,
};

pub type Result<T> = std::result::Result<T, &'static str>;
pub use canaveral_runner_client::Binding;
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Assignment {
    pub id: String,
    pub claim_id: String,
    pub domain_id: String,
    pub sequence: u64,
    pub closed: bool,
    pub cancel_requested: bool,
    pub job: ModelJob,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub executable: PathBuf,
    pub executable_sha256: String,
    pub models_dir: PathBuf,
    pub inventory: BTreeMap<String, String>,
    pub state_dir: PathBuf,
    pub startup_ms: u64,
    pub execution_ms: u64,
    pub contact_ms: u64,
    pub stop_ms: u64,
    pub response_bytes: u64,
    pub context_tokens: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Journal {
    pub binding: Binding,
    pub assignment: Assignment,
    pub sequence: u64,
    pub receipt: ModelJob,
    pub pending: bool,
    pub launch_intent: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Store {
    current: String,
    entries: BTreeMap<String, Journal>,
}
pub struct Executor {
    config: Config,
    _lock: File,
    journal: Option<Journal>,
    history: BTreeMap<String, Journal>,
    poisoned: bool,
}
#[derive(Clone, Copy)]
pub enum Control {
    Continue,
    Cancel,
    Fence,
}
fn private_dir(path: &Path) -> Result<()> {
    if !path.exists() {
        fs::create_dir(path).map_err(|_| "state directory creation failed")?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "permissions failed")?;
    }
    let meta = fs::symlink_metadata(path).map_err(|_| "directory unavailable")?;
    if !meta.is_dir() || meta.permissions().mode() & 0o077 != 0 {
        return Err("directory must be private");
    }
    Ok(())
}
fn save(path: &Path, value: &Store) -> Result<()> {
    let temp = path.join("receipt.next");
    // A failed publication poisons this executor; stale temp files are never adopted.
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)
        .map_err(|_| "receipt staging failed")?;
    let bytes = serde_json::to_vec(value).map_err(|_| "receipt encoding failed")?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "receipt sync failed")?;
    fs::rename(temp, path.join("receipt.json"))
        .and_then(|_| File::open(path)?.sync_all())
        .map_err(|_| "receipt publication failed")
}
fn receipt(
    job: &ModelJob,
    state: State,
    cancel: bool,
    stopped: bool,
    cleanup: Cleanup,
    result: Option<GenerationResult>,
) -> Result<ModelJob> {
    let r = ModelJob {
        version: 1,
        application_id: job.application_id.clone(),
        id: job.id.clone(),
        message: Message::Receipt {
            state,
            cancel_requested: cancel,
            stopped,
            cleanup,
            result,
        },
    };
    if !job.receipt_matches(&r) {
        return Err("invalid receipt");
    }
    Ok(r)
}
impl Executor {
    pub fn open(config: Config) -> Result<Self> {
        if !config.executable.is_absolute()
            || !config.models_dir.is_absolute()
            || !config.state_dir.is_absolute()
            || config.executable_sha256.len() != 64
            || !config
                .executable_sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("absolute operator paths and pinned runtime hash required");
        }
        if [
            config.startup_ms,
            config.execution_ms,
            config.contact_ms,
            config.stop_ms,
            config.response_bytes,
            config.context_tokens,
        ]
        .contains(&0)
        {
            return Err("explicit positive budgets required");
        }
        private_dir(&config.state_dir)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(config.state_dir.join("lock"))
            .map_err(|_| "lock open failed")?;
        if unsafe {
            libc::flock(
                std::os::fd::AsRawFd::as_raw_fd(&lock),
                libc::LOCK_EX | libc::LOCK_NB,
            )
        } != 0
        {
            return Err("executor already owned");
        }
        let path = config.state_dir.join("receipt.json");
        let stored: Option<Store> = if path.exists() {
            Some(
                serde_json::from_reader(File::open(path).map_err(|_| "receipt unavailable")?)
                    .map_err(|_| "corrupt receipt")?,
            )
        } else {
            None
        };
        let (journal, history) = if let Some(store) = stored {
            (
                Some(
                    store
                        .entries
                        .get(&store.current)
                        .ok_or("corrupt current receipt")?
                        .clone(),
                ),
                store.entries,
            )
        } else {
            (None, BTreeMap::new())
        };
        let mut this = Self {
            config,
            _lock: lock,
            journal,
            history,
            poisoned: false,
        };
        for j in this.history.values() {
            j.assignment.job.validate()?;
            j.receipt.validate()?;
            if !j.assignment.job.receipt_matches(&j.receipt) {
                return Err("corrupt receipt binding");
            }
        }
        if let Some(mut j) = this.journal.clone() {
            if j.launch_intent && !j.pending && !j.receipt.can_release() {
                if !matches!(
                    j.receipt.message,
                    Message::Receipt {
                        state: State::Unknown,
                        ..
                    }
                ) {
                    return Err("unresolved terminal receipt");
                }
                j.launch_intent = false;
                j.pending = true;
                this.persist(j)?;
            }
        }
        Ok(this)
    }
    fn persist(&mut self, j: Journal) -> Result<()> {
        if self.poisoned {
            return Err("executor fenced");
        }
        let key = format!(
            "{}:{}",
            j.assignment.job.application_id, j.assignment.job.id
        );
        let mut entries = self.history.clone();
        entries.insert(key.clone(), j.clone());
        if let Err(e) = save(
            &self.config.state_dir,
            &Store {
                current: key,
                entries: entries.clone(),
            },
        ) {
            self.poisoned = true;
            return Err(e);
        }
        self.history = entries;
        self.journal = Some(j);
        Ok(())
    }
    pub fn journal(&self) -> Option<&Journal> {
        self.journal.as_ref()
    }
    pub fn acknowledge(&mut self) -> Result<()> {
        let mut j = self.journal.clone().ok_or("no receipt")?;
        j.pending = false;
        self.persist(j)
    }
    pub fn blocked(&self) -> bool {
        self.poisoned
            || self
                .journal
                .as_ref()
                .is_some_and(|j| j.pending || !j.receipt.can_release())
    }
    pub fn execute<F: FnMut() -> Control>(
        &mut self,
        binding: Binding,
        a: Assignment,
        mut control: F,
    ) -> Result<&Journal> {
        if self.blocked() {
            return Err("unresolved assignment");
        }
        a.job.validate()?;
        if a.closed || a.sequence != 0 || uuid::Uuid::parse_str(&a.id).is_err() {
            return Err("unsupported assignment");
        }
        if self.history.values().any(|j| {
            j.assignment.id == a.id
                || (j.assignment.job.id == a.job.id
                    && j.assignment.job.application_id == a.job.application_id)
        }) {
            return Err("execution replay refused");
        }
        let Message::Submit { model, digest, .. } = &a.job.message else {
            return Err("submission required");
        };
        let valid_model = self.config.inventory.get(model) == Some(digest);
        let mut j = Journal {
            binding,
            assignment: a.clone(),
            sequence: 1,
            receipt: receipt(
                &a.job,
                State::Unknown,
                a.cancel_requested,
                false,
                Cleanup::Pending,
                None,
            )?,
            pending: false,
            launch_intent: true,
        };
        self.persist(j.clone())?; // Durable launch intent precedes every process effect.
        let work = self.config.state_dir.join("workspace");
        if work.exists() {
            return Err("unreconciled workspace");
        }
        private_dir(&work)?;
        let mut scope = None;
        let outcome = if a.cancel_requested {
            Err("cancelled")
        } else if !valid_model {
            Err("model not installed")
        } else {
            self.generate(&a.job, &work, &mut scope, &mut control)
        };
        if let Err(code) = &outcome {
            eprintln!("model execution: {code}");
        }
        let stopped = scope.as_mut().is_none_or(|s| s.stop(self.config.stop_ms));
        let cleanup = stopped && fs::remove_dir_all(&work).is_ok();
        let cancelled = a.cancel_requested || matches!(outcome, Err("cancelled"));
        let uncertain = matches!(
            outcome,
            Err("generation response lost" | "runtime read failed" | "generation deadline")
        );
        let (state, result) = if !stopped || uncertain {
            (State::Unknown, None)
        } else {
            match outcome {
                Ok(r) => (State::Succeeded, Some(r)),
                Err(_) if cancelled => (State::Cancelled, None),
                Err(_) => (State::Failed, None),
            }
        };
        j.receipt = receipt(
            &a.job,
            state,
            cancelled,
            stopped && state != State::Unknown,
            if cleanup && state != State::Unknown {
                Cleanup::Complete
            } else {
                Cleanup::Pending
            },
            result,
        )?;
        j.launch_intent = false;
        j.pending = true;
        self.persist(j)?;
        Ok(self.journal.as_ref().unwrap())
    }
    fn generate<F: FnMut() -> Control>(
        &self,
        job: &ModelJob,
        work: &Path,
        scope: &mut Option<Scope>,
        control: &mut F,
    ) -> Result<GenerationResult> {
        let Message::Submit {
            model,
            digest,
            prompt,
            max_tokens,
            ..
        } = &job.message
        else {
            return Err("submission required");
        };
        let mut executable = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&self.config.executable)
            .map_err(|_| "runtime unavailable")?;
        let meta = executable
            .metadata()
            .map_err(|_| "runtime metadata unavailable")?;
        if !meta.is_file() || meta.permissions().mode() & 0o022 != 0 {
            return Err("unsafe runtime permissions");
        }
        // Stage the verified bytes privately: macOS cannot execute /dev/fd artifacts.
        let staged = work.join("runtime");
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o500)
            .open(&staged)
            .map_err(|_| "runtime staging failed")?;
        let mut hash = Sha256::new();
        let mut buffer = [0; 65536];
        loop {
            let n = executable
                .read(&mut buffer)
                .map_err(|_| "runtime read failed")?;
            if n == 0 {
                break;
            }
            hash.update(&buffer[..n]);
            output
                .write_all(&buffer[..n])
                .map_err(|_| "runtime staging failed")?;
        }
        output.sync_all().map_err(|_| "runtime sync failed")?;
        drop(output);
        if format!("{:x}", hash.finalize()) != self.config.executable_sha256 {
            return Err("runtime identity mismatch");
        }
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|_| "loopback unavailable")?;
        let port = listener
            .local_addr()
            .map_err(|_| "loopback unavailable")?
            .port();
        let host = format!("127.0.0.1:{port}");
        let mut cmd = Command::new(&staged);
        cmd.arg("serve")
            .env_clear()
            .env("HOME", work)
            .env("TMPDIR", work)
            .env("OLLAMA_HOST", &host)
            .env("OLLAMA_MODELS", &self.config.models_dir)
            .env("OLLAMA_NO_CLOUD", "1")
            .env("OLLAMA_NUM_PARALLEL", "1")
            .env("OLLAMA_MAX_LOADED_MODELS", "1")
            .env(
                "OLLAMA_CONTEXT_LENGTH",
                self.config.context_tokens.to_string(),
            )
            .current_dir(work)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0);
        check(control)?;
        drop(listener);
        let child = cmd.spawn().map_err(|_| "runtime launch failed")?;
        *scope = Some(Scope {
            pgid: child.id() as i32,
            child,
        });
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .timeout(Duration::from_millis(200))
            .build()
            .map_err(|_| "HTTP client failed")?;
        let base = format!("http://{host}");
        let start = clock::Clock::now();
        let tags = loop {
            check(control)?;
            if scope
                .as_mut()
                .unwrap()
                .child
                .try_wait()
                .map_err(|_| "runtime wait failed")?
                .is_some()
            {
                return Err("runtime exited");
            }
            if start.elapsed() >= Duration::from_millis(self.config.startup_ms) {
                return Err("startup deadline");
            }
            if !socket_owner::owned(scope.as_ref().unwrap().child.id(), port) {
                std::thread::sleep(Duration::from_millis(20));
                continue;
            }
            if let Ok(r) = get_json(
                &client,
                &format!("{base}/api/tags"),
                self.config.response_bytes,
            ) {
                break r;
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let installed = tags
            .get("models")
            .and_then(|m| m.as_array())
            .is_some_and(|models| {
                models.iter().any(|v| {
                    v.get("name").and_then(|v| v.as_str()) == Some(model)
                        && v.get("digest")
                            .and_then(|v| v.as_str())
                            .is_some_and(|d| d == digest || format!("sha256:{d}") == *digest)
                })
            });
        if !installed {
            return Err("runtime model identity mismatch");
        }
        if !socket_owner::owned(scope.as_ref().unwrap().child.id(), port) {
            return Err("runtime socket ownership lost");
        }
        let url = format!("{base}/api/generate");
        let body = serde_json::json!({"model":model,"prompt":prompt,"stream":false,"keep_alive":0,"options":{"num_predict":max_tokens,"num_ctx":self.config.context_tokens}});
        let timeout = self.config.execution_ms;
        let bound = self.config.response_bytes;
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let worker = std::thread::spawn(move || {
            let result = (|| {
                let c = Client::builder()
                    .retry(reqwest::retry::never())
                    .no_proxy()
                    .redirect(reqwest::redirect::Policy::none())
                    .timeout(Duration::from_millis(timeout))
                    .build()
                    .map_err(|_| "HTTP client failed")?;
                decode(
                    c.post(url)
                        .json(&body)
                        .send()
                        .map_err(|_| "generation response lost")?,
                    bound,
                )
            })();
            let _ = tx.send(result);
        });
        let began = clock::Clock::now();
        let response = loop {
            if let Err(e) = check(control) {
                break Err(e);
            }
            if began.elapsed() >= Duration::from_millis(timeout) {
                break Err("generation deadline");
            }
            match rx.recv_timeout(Duration::from_millis(20)) {
                Ok(v) => break v,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    break Err("generation response lost")
                }
                Err(_) => {}
            }
        };
        // This thread owns only HTTP. Its configured timeout bounds its lifetime;
        // process fencing happens immediately in execute, before receipt publication.
        drop(worker);
        let v = response?;
        if v.get("done") != Some(&serde_json::Value::Bool(true))
            || v.get("model").and_then(|v| v.as_str()) != Some(model)
        {
            return Err("invalid generation identity");
        }
        let count = |key| {
            v.get(key)
                .and_then(|v| v.as_u64())
                .filter(|n| *n <= 2147483648)
                .ok_or("missing token measurement")
        };
        let r = GenerationResult {
            model: model.clone(),
            text: v
                .get("response")
                .and_then(|v| v.as_str())
                .ok_or("missing text")?
                .into(),
            usage: Usage {
                input_tokens: count("prompt_eval_count")?,
                output_tokens: count("eval_count")?,
            },
        };
        if r.usage.output_tokens > *max_tokens {
            return Err("output token budget exceeded");
        }
        receipt(
            job,
            State::Succeeded,
            false,
            true,
            Cleanup::Complete,
            Some(r.clone()),
        )?;
        Ok(r)
    }
}
fn check<F: FnMut() -> Control>(f: &mut F) -> Result<()> {
    match f() {
        Control::Continue => Ok(()),
        Control::Cancel => Err("cancelled"),
        Control::Fence => Err("controller contact deadline"),
    }
}
fn decode(response: reqwest::blocking::Response, bound: u64) -> Result<serde_json::Value> {
    if !response.status().is_success() {
        return Err("runtime rejected request");
    }
    let mut bytes = Vec::new();
    response
        .take(bound.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| "runtime read failed")?;
    if bytes.len() as u64 > bound {
        return Err("runtime output bound exceeded");
    }
    serde_json::from_slice::<json::Unique>(&bytes)
        .map(|value| value.0)
        .map_err(|_| "invalid runtime JSON")
}
fn get_json(client: &Client, url: &str, bound: u64) -> Result<serde_json::Value> {
    decode(
        client.get(url).send().map_err(|_| "runtime unavailable")?,
        bound,
    )
}
struct Scope {
    child: Child,
    pgid: i32,
}
impl Scope {
    fn stop(&mut self, budget: u64) -> bool {
        if self.pgid == 0 {
            return true;
        }
        unsafe {
            libc::kill(-self.pgid, libc::SIGKILL);
        }
        let start = clock::Clock::now();
        loop {
            let _ = self.child.try_wait();
            let absent = unsafe { libc::kill(-self.pgid, 0) } < 0
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
            if absent {
                self.pgid = 0;
                return true;
            }
            if start.elapsed() >= Duration::from_millis(budget) {
                return false;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for Scope {
    fn drop(&mut self) {
        if self.pgid > 0 {
            unsafe {
                libc::kill(-self.pgid, libc::SIGKILL);
            }
        }
    }
}
pub mod controller;
mod socket_owner;

mod clock;

mod json;
