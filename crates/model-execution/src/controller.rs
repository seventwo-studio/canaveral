//! One durable claim at a time, using the public controller's outbound runner routes.
use super::*;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunnerConfig {
    pub controller: String,
    pub credential_file: PathBuf,
    pub binding: Binding,
    pub execution: Config,
    pub ca_file: Option<PathBuf>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Claim {
    binding: Binding,
    id: uuid::Uuid,
}
#[derive(Clone)]
struct Controller {
    client: Client,
    origin: String,
    secret: String,
}
impl Controller {
    fn post(&self, route: &str, body: serde_json::Value) -> Result<serde_json::Value> {
        self.post_with_timeout(route, body, Duration::from_secs(20))
    }
    fn post_with_timeout(
        &self,
        route: &str,
        body: serde_json::Value,
        timeout: Duration,
    ) -> Result<serde_json::Value> {
        let body = serde_json::to_vec(&body).map_err(|_| "controller encoding failed")?;
        if body.len() > 1024 * 1024 {
            return Err("controller request bound exceeded");
        }
        decode(
            self.client
                .post(format!("{}{route}", self.origin))
                .timeout(timeout)
                .bearer_auth(&self.secret)
                .header("Content-Type", "application/json")
                .body(body)
                .send()
                .map_err(|_| "controller reply lost; retain claim and receipt")?,
            1024 * 1024,
        )
    }
}
/// Runs at most one assignment. Reinvoke with the same private state after a lost reply.
/// Unresolved execution prevents new claims; no enrollment, recovery or capacity advertising.
pub fn run_once(config: RunnerConfig) -> Result<()> {
    run_once_inner(config, None::<fn() -> Result<()>>)
}
/// The callback fences managed startup before any claim, report or execution effect.
/// Success proves private state validation and fresh exact-binding authentication.
pub fn run_once_with_ready(config: RunnerConfig, ready: impl FnOnce() -> Result<()>) -> Result<()> {
    run_once_inner(config, Some(ready))
}
fn run_once_inner(config: RunnerConfig, ready: Option<impl FnOnce() -> Result<()>>) -> Result<()> {
    let url = reqwest::Url::parse(&config.controller).map_err(|_| "invalid controller origin")?;
    let loopback = url
        .host_str()
        .and_then(|s| s.parse::<std::net::IpAddr>().ok())
        .is_some_and(|ip| ip.is_loopback());
    if !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
    {
        return Err("verified TLS or loopback origin required");
    }
    if config.binding.generation == 0 || config.binding.generation > 9_007_199_254_740_991 {
        return Err("invalid binding generation");
    }
    let secret = String::from_utf8(private::trust_file(&config.credential_file, true)?)
        .map_err(|_| "invalid credential")?
        .trim()
        .to_owned();
    if !(43..=128).contains(&secret.len())
        || !secret
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err("invalid credential");
    }
    let timeout = Duration::from_millis(config.execution.contact_ms.min(20_000));
    let mut builder = Client::builder()
        .retry(reqwest::retry::never())
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout);
    if let Some(path) = config.ca_file {
        let bytes = private::trust_file(&path, false)?;
        let certs = reqwest::Certificate::from_pem_bundle(&bytes).map_err(|_| "invalid CA")?;
        if certs.is_empty() {
            return Err("invalid CA");
        }
        for cert in certs {
            builder = builder.add_root_certificate(cert);
        }
    }
    let controller = Controller {
        client: builder.build().map_err(|_| "controller client failed")?,
        origin: config.controller.trim_end_matches('/').into(),
        secret,
    };
    let mut executor = Executor::open(config.execution.clone())?;
    if executor
        .journal()
        .is_some_and(|j| j.binding != config.binding)
    {
        return Err("state belongs to another binding");
    }
    if ready.is_some() {
        let proof = controller.post(
            "/v1/runners/authenticate",
            serde_json::to_value(&config.binding).map_err(|_| "invalid binding")?,
        )?;
        let expected = serde_json::to_value(&config.binding).map_err(|_| "invalid binding")?;
        if proof.as_object().is_none_or(|p| p.len() != 5)
            || expected
                .as_object()
                .ok_or("invalid binding")?
                .iter()
                .any(|(k, v)| proof.get(k) != Some(v))
            || proof
                .get("credentialRevision")
                .and_then(serde_json::Value::as_u64)
                != Some(1)
        {
            return Err("current binding authentication rejected");
        }
    }
    let prior_claim = executor.directory.read_optional("claim.json")?;
    if let Some(bytes) = &prior_claim {
        let claim: Claim = serde_json::from_slice(bytes).map_err(|_| "corrupt claim")?;
        if claim.binding != config.binding || claim.id.is_nil() {
            return Err("claim binding changed");
        }
    }
    // This marker makes a missing receipt distinguishable from a provably undispatched claim.
    let marker = executor.directory.read_optional("update-history.json")?;
    if marker.is_none() {
        let dispatched = executor.journal().is_some() || prior_claim.is_some();
        executor.directory.write(
            "update-history.json",
            "update-history.next",
            &serde_json::to_vec(
                &serde_json::json!({"binding":config.binding,"dispatched":dispatched}),
            )
            .map_err(|_| "invalid update history")?,
        )?;
    }
    if let Some(ready) = ready {
        executor.prepare();
        executor.staged.as_ref().map_err(|error| *error)?;
        ready()?;
    }
    if let Some(j) = executor.journal() {
        if j.binding != config.binding {
            return Err("state belongs to another binding");
        }
        if j.pending {
            report(&controller, j)?;
            executor.acknowledge()?;
            return Ok(());
        }
        if executor.blocked() {
            return Err("unknown execution requires reconciliation; reservations retained");
        }
    }
    executor.prepare(); // Standard one-shot retains its report-before-staging behavior.
    executor.staged.as_ref().map_err(|error| *error)?;
    let mut claim: Claim = match executor.directory.read_optional("claim.json")? {
        Some(bytes) => serde_json::from_slice(&bytes).map_err(|_| "corrupt claim")?,
        None => new_claim(config.binding.clone())?,
    };
    if claim.binding != config.binding {
        return Err("claim binding changed");
    }
    if executor
        .journal()
        .is_some_and(|j| j.assignment.claim_id == claim.id.to_string())
    {
        claim = new_claim(config.binding.clone())?;
    }
    executor.directory.write(
        "claim.json",
        "claim.next",
        &serde_json::to_vec(&claim).map_err(|_| "claim encoding failed")?,
    )?;
    let claim_started = clock::Clock::now();
    let response = controller.post(
        "/v1/runners/model-jobs/claim",
        serde_json::json!({"binding":config.binding,"claimId":claim.id}),
    )?;
    let value = response.get("assignment").ok_or("invalid claim response")?;
    if value.is_null() {
        return Ok(());
    }
    let assignment: Assignment =
        serde_json::from_value(value.clone()).map_err(|_| "invalid assignment")?;
    if assignment.claim_id != claim.id.to_string() {
        return Err("claim identity mismatch");
    }
    let expected = assignment.clone();
    let mut last_contact = claim_started;
    let mut last_poll = clock::Clock::now();
    let mut poll: Option<(
        clock::Clock,
        std::sync::mpsc::Receiver<Result<serde_json::Value>>,
    )> = None;
    executor.directory.write(
        "update-history.json",
        "update-history.next",
        &serde_json::to_vec(&serde_json::json!({"binding":config.binding,"dispatched":true}))
            .map_err(|_| "invalid update history")?,
    )?;
    let j = executor.execute(config.binding.clone(), assignment, || {
        if last_contact.elapsed() >= timeout {
            return Control::Fence;
        }
        if poll.is_none() && last_poll.elapsed() >= Duration::from_millis(100) {
            let started = clock::Clock::now();
            last_poll = started;
            let c = controller.clone();
            let body = serde_json::json!({"binding":config.binding});
            let remaining = timeout.saturating_sub(last_contact.elapsed());
            let (tx, rx) = std::sync::mpsc::sync_channel(1);
            std::thread::spawn(move || {
                let _ = tx.send(c.post_with_timeout(
                    "/v1/runners/model-jobs/assignments",
                    body,
                    remaining,
                ));
            });
            poll = Some((started, rx));
        }
        let Some((started, rx)) = &poll else {
            return Control::Continue;
        };
        let started = *started;
        let response = match rx.try_recv() {
            Ok(v) => v,
            Err(std::sync::mpsc::TryRecvError::Empty) => return Control::Continue,
            Err(_) => return Control::Fence,
        };
        poll = None;
        match response {
            Ok(v) => {
                if last_contact.elapsed() >= timeout {
                    return Control::Fence;
                }
                let assignments: Vec<Assignment> = match v
                    .get("assignments")
                    .cloned()
                    .and_then(|a| serde_json::from_value(a).ok())
                {
                    Some(a) => a,
                    None => return Control::Fence,
                };
                let Some(current) = assignments.iter().find(|a| a.id == expected.id) else {
                    return Control::Fence;
                };
                if current.job != expected.job
                    || current.claim_id != expected.claim_id
                    || current.domain_id != expected.domain_id
                    || current.sequence != expected.sequence
                    || current.closed
                {
                    return Control::Fence;
                }
                last_contact = started;
                if current.cancel_requested {
                    Control::Cancel
                } else {
                    Control::Continue
                }
            }
            Err(_) => Control::Fence,
        }
    })?;
    report(&controller, j)?;
    executor.acknowledge()
}
fn new_claim(binding: Binding) -> Result<Claim> {
    let mut bytes = [0; 16];
    getrandom::fill(&mut bytes).map_err(|_| "randomness unavailable")?;
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    Ok(Claim {
        binding,
        id: uuid::Uuid::from_bytes(bytes),
    })
}
fn report(c: &Controller, j: &Journal) -> Result<()> {
    let v=c.post("/v1/runners/model-jobs/report",serde_json::json!({"binding":j.binding,"assignmentId":j.assignment.id,"sequence":j.sequence,"receipt":j.receipt}))?;
    let Message::Receipt {
        state,
        cancel_requested,
        stopped,
        cleanup,
        ..
    } = &j.receipt.message
    else {
        return Err("invalid stored report");
    };
    if v.get("assignmentId") != Some(&serde_json::json!(j.assignment.id))
        || v.get("sequence") != Some(&serde_json::json!(j.sequence))
        || v.get("state") != Some(&serde_json::json!(state))
        || !v
            .get("cancelRequested")
            .and_then(|v| v.as_bool())
            .is_some_and(|current| current || !cancel_requested)
        || v.get("stopped") != Some(&serde_json::json!(stopped))
        || v.get("cleanup") != Some(&serde_json::json!(cleanup))
        || v.get("released") != Some(&serde_json::json!(j.receipt.can_release()))
    {
        return Err("report acknowledgement mismatch");
    }
    Ok(())
}

/// Positive idle needs acknowledged terminal receipts with stop and cleanup proof, plus no workspace.
/// No executor is opened and no pending journal is repaired by this readonly inspection.
pub fn update_status(config: &RunnerConfig) -> Result<bool> {
    if config.binding.generation == 0
        || config.binding.controller_id.is_nil()
        || config.binding.runner_id.is_nil()
        || config.binding.incarnation_id.is_nil()
    {
        return Err("invalid binding");
    }
    let secret = private::trust_file(&config.credential_file, true)?;
    let secret = std::str::from_utf8(&secret)
        .map_err(|_| "invalid credential")?
        .trim();
    if !(43..=128).contains(&secret.len())
        || !secret
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err("invalid credential");
    }
    with_update_status_lock(&config.execution.state_dir, || {
        for name in [
            "workspace",
            "receipt.next",
            "claim.next",
            "update-history.next",
        ] {
            if !update_path_absent(&config.execution.state_dir.join(name))? {
                return Ok(false);
            }
        }
        let path = config.execution.state_dir.join("receipt.json");
        if update_path_absent(&path)? {
            let marker_path = config.execution.state_dir.join("update-history.json");
            let pristine = update_path_absent(&marker_path)?;
            if !pristine {
                let marker: serde_json::Value =
                    serde_json::from_slice(&private::trust_file(&marker_path, true)?)
                        .map_err(|_| "invalid update history")?;
                if marker != serde_json::json!({"binding":config.binding,"dispatched":false}) {
                    return Ok(false);
                }
            }
            // A missing receipt never erases a published dispatch history.
            for entry in std::fs::read_dir(&config.execution.state_dir)
                .map_err(|_| "state inventory unavailable")?
            {
                let entry = entry.map_err(|_| "state inventory unavailable")?;
                if (pristine && entry.file_name() != "lock")
                    || !["lock", "runtime", "claim.json", "update-history.json"]
                        .iter()
                        .any(|n| entry.file_name() == *n)
                {
                    return Ok(false);
                }
            }
        } else {
            let store: Store = serde_json::from_slice(&private::trust_file(&path, true)?)
                .map_err(|_| "invalid update journal")?;
            if !store.entries.contains_key(&store.current) || store.entries.is_empty() {
                return Err("missing current journal");
            }
            for j in store.entries.values() {
                j.receipt.validate()?;
                j.assignment.job.validate()?;
                if j.binding != config.binding
                    || !j.assignment.job.receipt_matches(&j.receipt)
                    || j.pending
                    || j.launch_intent
                    || !j.stop_confirmed
                    || !j.cleanup_confirmed
                    || !j.receipt.can_release()
                {
                    return Ok(false);
                }
            }
        }
        let claim = config.execution.state_dir.join("claim.json");
        if !update_path_absent(&claim)? {
            let claim: Claim = serde_json::from_slice(&private::trust_file(&claim, true)?)
                .map_err(|_| "invalid claim")?;
            if claim.binding != config.binding || claim.id.is_nil() {
                return Ok(false);
            }
        }
        Ok(true)
    })
}

/// Inspect under the same existing exclusive lock as ordinary execution; never create or repair state.
fn with_update_status_lock(
    path: &std::path::Path,
    inspect: impl FnOnce() -> Result<bool>,
) -> Result<bool> {
    use std::os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt},
    };
    let dir = private::walk(path)?;
    let dm = dir.metadata().map_err(|_| "update state unavailable")?;
    if dm.uid() != unsafe { libc::geteuid() } || dm.mode() & 0o7777 != 0o700 {
        return Err("private update state required");
    }
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path.join("lock"))
        .map_err(|_| "existing runtime lock required")?;
    let lm = lock.metadata().map_err(|_| "update lock unavailable")?;
    if !lm.is_file() || lm.nlink() != 1 || lm.uid() != dm.uid() || lm.mode() & 0o7777 != 0o600 {
        return Err("private runtime lock required");
    }
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Ok(false);
    }
    let check = || -> Result<()> {
        let current = private::walk(path)?
            .metadata()
            .map_err(|_| "update directory changed")?;
        let current_lock =
            std::fs::symlink_metadata(path.join("lock")).map_err(|_| "update lock changed")?;
        if (current.dev(), current.ino()) != (dm.dev(), dm.ino())
            || (current_lock.dev(), current_lock.ino()) != (lm.dev(), lm.ino())
        {
            return Err("update state ownership changed");
        }
        Ok(())
    };
    check()?;
    let result = inspect()?;
    check()?;
    Ok(result)
}
fn update_path_absent(path: &std::path::Path) -> Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(false),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(_) => Err("update path unavailable"),
    }
}

#[cfg(test)]
mod update_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    fn fixture() -> (tempfile::TempDir, RunnerConfig) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let credential_file = root.join("credential");
        fs::write(&credential_file, "a".repeat(43)).unwrap();
        fs::set_permissions(&credential_file, fs::Permissions::from_mode(0o600)).unwrap();
        let models = root.join("models");
        fs::create_dir(&models).unwrap();
        let executable = root.join("fixture-bytes");
        fs::write(&executable, b"signed fixture bytes, never executed").unwrap();
        let binding = Binding {
            controller_id: uuid::Uuid::from_u128(1),
            runner_id: uuid::Uuid::from_u128(2),
            generation: 1,
            incarnation_id: uuid::Uuid::from_u128(3),
        };
        let config = RunnerConfig {
            controller: "http://127.0.0.1:1".into(),
            credential_file,
            binding,
            ca_file: None,
            execution: Config {
                executable,
                executable_sha256: format!(
                    "{:x}",
                    Sha256::digest(b"signed fixture bytes, never executed")
                ),
                models_dir: models,
                inventory: BTreeMap::new(),
                state_dir: root.join("state"),
                startup_ms: 1000,
                execution_ms: 1000,
                contact_ms: 1000,
                stop_ms: 1000,
                response_bytes: 1024,
                context_tokens: 1024,
            },
        };
        (temp, config)
    }
    #[test]
    fn update_status_uses_existing_lock_and_never_repairs_unknown_history() {
        let (_temp, c) = fixture();
        assert!(update_status(&c).is_err()); // No state is created by status.
        let dir = private::Directory::open(&c.execution.state_dir).unwrap();
        assert_eq!(update_status(&c), Ok(false));
        drop(dir);
        assert_eq!(update_status(&c), Ok(true));
        let dir = private::Directory::open(&c.execution.state_dir).unwrap();
        dir.write(
            "update-history.json",
            "update-history.next",
            &serde_json::to_vec(&serde_json::json!({"binding":c.binding,"dispatched":false}))
                .unwrap(),
        )
        .unwrap();
        drop(dir);
        assert_eq!(update_status(&c), Ok(true));
        fs::create_dir(c.execution.state_dir.join("workspace")).unwrap();
        assert_eq!(update_status(&c), Ok(false));
        fs::remove_dir(c.execution.state_dir.join("workspace")).unwrap();
        let dir = private::Directory::open(&c.execution.state_dir).unwrap();
        dir.write(
            "update-history.json",
            "update-history.next",
            &serde_json::to_vec(&serde_json::json!({"binding":c.binding,"dispatched":true}))
                .unwrap(),
        )
        .unwrap();
        drop(dir);
        assert_eq!(update_status(&c), Ok(false)); // Missing receipt after dispatch cannot become idle.
    }
    #[test]
    fn readiness_requires_current_binding_authentication_before_any_claim() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
        };
        for valid in [false, true] {
            let (_temp, mut c) = fixture();
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            c.controller = format!("http://{}", listener.local_addr().unwrap());
            let mut proof = serde_json::to_value(&c.binding).unwrap();
            proof["credentialRevision"] = serde_json::json!(if valid { 1 } else { 2 });
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut b = [0];
                while !bytes.ends_with(b"\r\n\r\n") {
                    stream.read_exact(&mut b).unwrap();
                    bytes.push(b[0]);
                }
                assert!(
                    String::from_utf8_lossy(&bytes).starts_with("POST /v1/runners/authenticate ")
                );
                let header = String::from_utf8_lossy(&bytes).to_ascii_lowercase();
                let length: usize = header
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length: "))
                    .unwrap()
                    .parse()
                    .unwrap();
                let mut payload = vec![0; length];
                stream.read_exact(&mut payload).unwrap();
                let body = proof.to_string();
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
            });
            let state = c.execution.state_dir.clone();
            let called = std::cell::Cell::new(false);
            let result = run_once_with_ready(c, || {
                called.set(true);
                assert!(!state.join("claim.json").exists());
                Err("fixture stop before claim")
            });
            assert!(result.is_err());
            assert_eq!(called.get(), valid, "result={result:?}");
            assert!(!state.join("claim.json").exists());
            server.join().unwrap();
        }
    }
}
