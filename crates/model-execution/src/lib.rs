//! Owned, non-streaming model execution with managed runtime provisioning.
#![cfg(unix)]
use canaveral_execution_core::model_job::{
    Cleanup, GenerationResult, Message, ModelJob, State, Usage,
};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
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
    #[serde(default)]
    pub backend: runtime_backend::Backend,
    #[serde(default)]
    pub acceleration: runtime_policy::Acceleration,
    #[serde(default)]
    pub model_files: BTreeMap<String, runtime_backend::ModelFiles>,
    #[serde(default)]
    pub executable: PathBuf,
    #[serde(default)]
    pub executable_sha256: String,
    #[serde(default)]
    pub runtime_packages: Vec<runtime_package::RuntimePackage>,
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
    #[serde(default)]
    pub stop_confirmed: bool,
    #[serde(default)]
    pub cleanup_confirmed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_package_digest: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Store {
    current: String,
    entries: BTreeMap<String, Journal>,
}
#[derive(Default)]
struct PackageReferences {
    all: bool,
    digests: std::collections::BTreeSet<String>,
}
impl PackageReferences {
    fn from_history(history: &BTreeMap<String, Journal>) -> Self {
        let mut references = Self::default();
        for journal in history
            .values()
            .filter(|j| j.launch_intent || j.pending || !j.receipt.can_release())
        {
            match &journal.runtime_package_digest {
                Some(digest) => {
                    references.digests.insert(digest.clone());
                }
                // A journal predating package identities can refer to any cached version.
                None => references.all = true,
            }
        }
        references
    }
    fn contains(&self, cache: &str) -> bool {
        self.all
            || cache
                .strip_prefix("runtime-package.")
                .is_some_and(|digest| self.digests.contains(digest))
    }
}

fn load_history(directory: &private::Directory) -> Result<Option<Store>> {
    let store = directory
        .read_optional("receipt.json")?
        .map(|bytes| serde_json::from_slice::<Store>(&bytes).map_err(|_| "corrupt receipt"))
        .transpose()?;
    if let Some(store) = &store {
        if !store.entries.contains_key(&store.current) {
            return Err("corrupt current receipt");
        }
        for journal in store.entries.values() {
            journal.assignment.job.validate()?;
            journal.receipt.validate()?;
            if !journal.assignment.job.receipt_matches(&journal.receipt)
                || journal
                    .runtime_package_digest
                    .as_deref()
                    .is_some_and(|digest| !runtime_package::hash_valid(digest))
            {
                return Err("corrupt receipt binding");
            }
        }
    }
    Ok(store)
}

pub struct Executor {
    config: Config,
    directory: private::Directory,
    staged: Result<runtime_package::StagedRuntime>,
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
        runtime_package::validate(&config)?;
        config.backend.validate(&config)?;
        if !config.models_dir.is_absolute() || !config.state_dir.is_absolute() {
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
        let directory = private::Directory::open(&config.state_dir)?;
        let stored = load_history(&directory)?;
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
            staged: Err("runtime not staged"),
            directory,
            journal,
            history,
            poisoned: false,
        };
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
        let bytes = serde_json::to_vec(&Store {
            current: key,
            entries: entries.clone(),
        })
        .map_err(|_| "receipt encoding failed")?;
        if let Err(e) = self.directory.write("receipt.json", "receipt.next", &bytes) {
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
        self.directory.check()?;
        self.prepare();
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
        let Message::Submit {
            adapter,
            model,
            digest,
            ..
        } = &a.job.message
        else {
            return Err("submission required");
        };
        let valid_model = adapter == self.config.backend.adapter()
            && self.config.inventory.get(model) == Some(digest);
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
            stop_confirmed: false,
            cleanup_confirmed: false,
            runtime_package_digest: self.staged.as_ref().ok().and_then(|staged| {
                let relative = staged
                    .entrypoint
                    .strip_prefix(&self.config.state_dir)
                    .ok()?;
                relative
                    .components()
                    .next()?
                    .as_os_str()
                    .to_str()?
                    .strip_prefix("runtime-package.")
                    .map(str::to_owned)
            }),
        };
        self.persist(j.clone())?; // Durable launch intent precedes every process effect.
        let work = self.config.state_dir.join("workspace");
        self.directory.workspace()?;
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
        let stopped = scope.as_mut().is_none_or(|s| {
            s.stop(
                self.config.stop_ms,
                self.config.backend == runtime_backend::Backend::Ollama
                    && self.config.executable.as_os_str().is_empty(),
            )
        });
        let cleanup = stopped && self.directory.cleanup_workspace().is_ok();
        let cancelled = a.cancel_requested || matches!(outcome, Err("cancelled"));
        let uncertain = matches!(
            outcome,
            Err("generation response lost" | "generation body lost")
        );
        let (state, result) =
            if !stopped || uncertain || (matches!(outcome, Err("generation deadline")) && !cleanup)
            {
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
        j.stop_confirmed = stopped;
        j.cleanup_confirmed = cleanup;
        j.launch_intent = false;
        j.pending = true;
        self.persist(j)?;
        Ok(self.journal.as_ref().unwrap())
    }
    fn prepare(&mut self) {
        if self.staged == Err("runtime not staged") {
            self.staged = self.stage_runtime();
        }
    }
    fn stage_runtime(&self) -> Result<runtime_package::StagedRuntime> {
        validate_models(&self.config.models_dir)?;
        self.config.backend.verify_models(&self.config)?;
        let references = PackageReferences::from_history(&self.history);
        if let Some(package) = runtime_package::select(&self.config.runtime_packages)? {
            return runtime_package::stage(
                package,
                &self.directory,
                &self.config.state_dir,
                &references,
            );
        }
        if self.config.executable.as_os_str().is_empty() {
            let pin = runtime_archive::host_pin(self.config.backend)
                .ok_or("no runtime package for this host")?;
            return runtime_archive::stage(
                pin,
                &self.directory,
                &self.config.state_dir,
                &references,
                false,
            );
        }
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
        let mut output = self.directory.runtime_output()?;
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
        let staged_metadata = output
            .metadata()
            .map_err(|_| "runtime metadata unavailable")?;
        drop(output);
        if format!("{:x}", hash.finalize()) != self.config.executable_sha256 {
            return Err("runtime identity mismatch");
        }
        self.directory.check()?;
        let identity = runtime_package::ExecutableIdentity::from_metadata(&staged_metadata);
        Ok(runtime_package::StagedRuntime::new(
            self.config.state_dir.clone(),
            "runtime",
            [("runtime".to_owned(), identity)].into_iter().collect(),
        ))
    }

    fn generate<F: FnMut() -> Control>(
        &self,
        job: &ModelJob,
        work: &Path,
        scope: &mut Option<Scope>,
        control: &mut F,
    ) -> Result<GenerationResult> {
        let Message::Submit { model, digest, .. } = &job.message else {
            return Err("submission required");
        };
        self.directory.check()?;
        let staged = self.staged.as_ref().map_err(|e| *e)?;
        let backend = self.config.backend;
        let mut random = [0u8; 32];
        getrandom::fill(&mut random).map_err(|_| "runtime secret unavailable")?;
        let key: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let key_file = work.join("runtime.key");
        let auth = backend.authenticated().then_some(key.as_str());
        if auth.is_some() {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&key_file)
                .map_err(|_| "runtime key unavailable")?;
            file.write_all(key.as_bytes())
                .map_err(|_| "runtime key write failed")?;
            file.sync_all().map_err(|_| "runtime key sync failed")?;
        }
        let import = if backend == runtime_backend::Backend::Ollama {
            self.config.model_files.get(model)
        } else {
            None
        };
        let store = work.join("ollama-models");
        if import.is_some() {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new()
                .mode(0o700)
                .create(&store)
                .map_err(|_| "Ollama private store unavailable")?;
        }
        let launch = |scope: &mut Option<Scope>| -> Result<u16> {
            let listener = TcpListener::bind("127.0.0.1:0").map_err(|_| "loopback unavailable")?;
            let port = listener
                .local_addr()
                .map_err(|_| "loopback unavailable")?
                .port();
            let mut cmd = Command::new(&staged.entrypoint);
            cmd.env_clear()
                .env("HOME", work)
                .env("TMPDIR", work)
                .current_dir(work)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .process_group(0);
            backend.configure(&mut cmd, &self.config, model, port, &key, &key_file)?;
            if self.config.executable.as_os_str().is_empty()
                && self.config.runtime_packages.is_empty()
            {
                staged.configure_loader(&mut cmd)?;
            }
            if import.is_some() {
                cmd.env("OLLAMA_MODELS", &store);
            }
            staged.verify_executables(&self.directory)?;
            drop(listener);
            let child = cmd.spawn().map_err(|_| "runtime launch failed")?;
            *scope = Some(Scope {
                pgid: child.id() as i32,
                child,
                signalled: false,
                reaped: false,
            });
            Ok(port)
        };

        let start = clock::Clock::now();
        let budget = Duration::from_millis(self.config.startup_ms);
        let mut startup = Startup {
            directory: &self.directory,
            start,
            budget,
            control,
        };
        startup.check()?;
        let mut port = launch(scope)?;
        let mut inventory_model = model.as_str();
        let mut inventory_digest = digest.clone();
        if let Some(artifact) = import {
            let server = scope.as_mut().unwrap();
            startup.probe(
                server,
                port,
                "/api/version",
                None,
                self.config.response_bytes,
            )?;
            let remaining = budget.saturating_sub(start.elapsed());
            let client = runtime_client(remaining)?;
            let source = self.config.models_dir.join(&artifact.path);
            let expected = digest.clone();
            let pid = server.child.id();
            let base = format!("http://127.0.0.1:{port}");
            let (tx, rx) = std::sync::mpsc::sync_channel(1);
            std::thread::spawn(move || {
                let _ = tx.send(ollama_import::create(
                    &client, &base, pid, port, &source, &expected,
                ));
            });
            startup.wait(Some(server), &rx)??;
            if !server.stop(self.config.stop_ms, true) {
                return Err("Ollama importer stop unconfirmed");
            }
            let (tx, rx) = std::sync::mpsc::sync_channel(1);
            let (store, digest) = (store.clone(), digest.clone());
            std::thread::spawn(move || {
                let _ = tx.send(ollama_import::verify(&store, &digest));
            });
            inventory_digest = startup.wait(None, &rx)??;
            inventory_model = ollama_import::ALIAS;
            startup.check()?;
            port = launch(scope)?;
        }
        let server = scope.as_ref().unwrap();
        if backend == runtime_backend::Backend::LlamaCpp {
            let health =
                startup.probe(server, port, "/health", auth, self.config.response_bytes)?;
            if health["status"] != "ok" {
                return Err("unexpected runtime health response");
            }
        }
        let tags = startup.probe(
            server,
            port,
            backend.inventory_route(),
            auth,
            self.config.response_bytes,
        )?;
        if !backend.inventory_matches(&self.config, &tags, inventory_model, &inventory_digest) {
            return Err("runtime model identity mismatch");
        }
        if !socket_owner::owned(server.child.id(), port) {
            return Err("runtime socket ownership lost");
        }
        let base = format!("http://127.0.0.1:{port}");
        let url = format!("{base}{}", self.config.backend.generation_route());
        let manifest_reference;
        let runtime_model = if import.is_some() {
            // Ollama resolves this request directly to the verified manifest blob.
            manifest_reference = inventory_digest.replacen(':', "-", 1);
            &manifest_reference
        } else {
            backend.alias(model)
        };
        let body = backend.request(&self.config, job, runtime_model)?;
        let auth = self.config.backend.authenticated().then_some(key);
        let timeout = self.config.execution_ms;
        let bound = self.config.response_bytes;
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        check(control)?;
        let began = clock::Clock::now();
        let worker = std::thread::spawn(move || {
            let result = (|| {
                let c = runtime_client(Duration::from_millis(timeout))?;
                decode(
                    {
                        let request = c.post(url).json(&body);
                        let request = if let Some(auth) = auth {
                            request.bearer_auth(auth)
                        } else {
                            request
                        };
                        request.send()
                    }
                    .map_err(|e| {
                        if e.is_timeout() {
                            "generation deadline"
                        } else {
                            "generation response lost"
                        }
                    })?,
                    bound,
                )
            })();
            let _ = tx.send(result);
        });
        let response = loop {
            if let Err(e) = self.directory.check().and_then(|_| check(control)) {
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
        let v = response.map_err(|e| {
            if e == "runtime read failed" {
                "generation body lost"
            } else {
                e
            }
        })?;
        let r = backend.result(job, runtime_model, &v)?;
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

fn runtime_client(timeout: Duration) -> Result<Client> {
    Client::builder()
        .retry(reqwest::retry::never())
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .build()
        .map_err(|_| "HTTP client failed")
}

struct Startup<'a, F> {
    directory: &'a private::Directory,
    start: clock::Clock,
    budget: Duration,
    control: &'a mut F,
}

impl<F: FnMut() -> Control> Startup<'_, F> {
    fn check(&mut self) -> Result<()> {
        self.directory.check()?;
        check(self.control)?;
        if self.start.elapsed() >= self.budget {
            return Err("startup deadline");
        }
        Ok(())
    }

    fn wait<T>(
        &mut self,
        server: Option<&Scope>,
        response: &std::sync::mpsc::Receiver<T>,
    ) -> Result<T> {
        loop {
            self.check()?;
            if let Some(server) = server {
                server.check_running()?;
            }
            match response.recv_timeout(Duration::from_millis(20)) {
                Ok(value) => return Ok(value),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("runtime startup request lost");
                }
            }
        }
    }

    fn probe(
        &mut self,
        server: &Scope,
        port: u16,
        route: &str,
        auth: Option<&str>,
        bound: u64,
    ) -> Result<serde_json::Value> {
        let client = runtime_client(Duration::from_millis(200))?;
        let url = format!("http://127.0.0.1:{port}{route}");
        loop {
            self.check()?;
            server.check_running()?;
            if socket_owner::owned(server.child.id(), port) {
                let (tx, rx) = std::sync::mpsc::sync_channel(1);
                let (client, url, auth) = (client.clone(), url.clone(), auth.map(str::to_owned));
                std::thread::spawn(move || {
                    let _ = tx.send(get_json(&client, &url, bound, auth.as_deref()));
                });
                if let Ok(value) = self.wait(Some(server), &rx)? {
                    return Ok(value);
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
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
fn get_json(
    client: &Client,
    url: &str,
    bound: u64,
    auth: Option<&str>,
) -> Result<serde_json::Value> {
    decode(
        {
            let request = client.get(url);
            let request = if let Some(auth) = auth {
                request.bearer_auth(auth)
            } else {
                request
            };
            request.send().map_err(|_| "runtime unavailable")?
        },
        bound,
    )
}
struct Scope {
    child: Child,
    pgid: i32,
    signalled: bool,
    reaped: bool,
}
impl Scope {
    fn check_running(&self) -> Result<()> {
        if self.exited()? {
            return Err("runtime exited before readiness");
        }
        Ok(())
    }

    fn exited(&self) -> Result<bool> {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        if unsafe {
            libc::waitid(
                libc::P_PID,
                self.child.id(),
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        } != 0
        {
            return Err("runtime wait failed");
        }
        Ok(unsafe { info.si_pid() } != 0)
    }
    fn signal(&mut self) {
        if !self.signalled && !self.reaped {
            unsafe {
                libc::kill(-self.pgid, libc::SIGKILL);
            }
            self.signalled = true;
        }
    }
    fn stop(&mut self, budget: u64, drain_helpers: bool) -> bool {
        if self.pgid == 0 {
            return true;
        }
        let start = clock::Clock::now();
        // Keep the leader waitable through both signals. A short graceful phase
        // lets supported runtimes reap descendants before the final group fence.
        if !self.signalled && !self.reaped {
            if drain_helpers {
                // Ollama shuts down and reaps its own helpers on SIGTERM.
                // Keep them alive for that handshake before fencing the group.
                unsafe { libc::kill(self.pgid, libc::SIGTERM) };
                let grace = Duration::from_millis((budget / 2).min(2000));
                while start.elapsed() < grace && self.exited() == Ok(false) {
                    std::thread::sleep(Duration::from_millis(10));
                }
            } else {
                unsafe { libc::kill(-self.pgid, libc::SIGTERM) };
                std::thread::sleep(Duration::from_millis((budget / 4).min(50)));
            }
        }
        self.signal();
        loop {
            if !self.reaped {
                self.reaped = self.child.try_wait().ok().flatten().is_some();
            }
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
            self.signal();
        }
    }
}
pub mod controller;
mod runtime_archive;
pub mod runtime_backend;
pub mod runtime_management;
pub mod runtime_package;
pub mod runtime_policy;
mod socket_owner;

mod clock;

mod json;

mod ollama_import;
mod private;

fn validate_models(path: &Path) -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    private::walk(path)?;
    fn visit(path: &Path) -> Result<()> {
        let m = fs::symlink_metadata(path).map_err(|_| "model directory unavailable")?;
        if !(m.uid() == 0 || m.uid() == unsafe { libc::geteuid() })
            || m.mode() & 0o022 != 0
            || m.file_type().is_symlink()
        {
            return Err("unsafe model directory");
        }
        if m.is_dir() {
            for e in fs::read_dir(path).map_err(|_| "model directory unavailable")? {
                visit(&e.map_err(|_| "model directory unavailable")?.path())?;
            }
        } else if !m.is_file() || m.nlink() != 1 {
            return Err("unsafe model file");
        }
        Ok(())
    }
    visit(path)
}
