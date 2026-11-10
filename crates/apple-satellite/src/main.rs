#[cfg(unix)]
fn run() -> Result<(), &'static str> {
    use canaveral_apple_satellite::{read_config, run_once_with_ready, Config};
    let args: Vec<_> = std::env::args().skip(1).collect();
    let managed = args.first().is_some_and(|v| v == "--update-managed");
    let check = args.first().is_some_and(|v| v == "--update-check");
    let status = args.first().is_some_and(|v| v == "--update-status");
    let (path, state) = if managed
        && args.len() == 5
        && args[1] == "--config"
        && args[3] == "--state"
    {
        (&args[2], Some(&args[4]))
    } else if (check || status || args.first().is_some_and(|v| v == "run-once")) && args.len() == 2
    {
        (&args[1], None)
    } else {
        return Err(
            "expected run-once CONFIG, --update-check CONFIG, or --update-managed --config CONFIG --state STATE",
        );
    };
    let config: Config = read_config(std::path::Path::new(path))?;
    if !check && !status && !managed {
        return run_once_with_ready(config, || Ok(()));
    }
    if state.is_some_and(|s| std::path::Path::new(s) != config.state) {
        return Err("managed state binding mismatch");
    }
    let _ = private_bytes(std::path::Path::new(path))?;
    check_saved_identity(&config)?;
    let ca = config
        .ca
        .as_ref()
        .map(|p| canaveral_apple_satellite::read_ca(p))
        .transpose()?;
    let _ = canaveral_runner_client::Transport::new(&config.origin, ca.as_deref())
        .map_err(|_| "invalid HTTPS trust")?;
    if status {
        let idle = canaveral_apple_satellite::update_status(&config).unwrap_or(false);
        println!(
            "{}",
            serde_json::json!({"type":"canaveral-update-status","version":1,"binding":config.binding,"idle":idle,"workloadsStopped":idle,"quiesced":idle})
        );
        return Ok(());
    }
    if check {
        println!("{{\"type\":\"canaveral-update-check\",\"version\":1,\"runtime\":\"apple\"}}");
        return Ok(());
    }
    let pinned_config = private_bytes(std::path::Path::new(path))?;
    let mut channel = Managed::open()?;
    channel.phase("canaveral-update-ready", "canaveral-update-activate")?;
    let mut service = None;
    let mut committed = false;
    let _result = run_once_with_ready(config, || {
        channel.phase("canaveral-update-started", "canaveral-update-committed")?;
        service = Some(channel.service(std::path::PathBuf::from(path), pinned_config.clone())?);
        channel.ack()?;
        committed = true;
        Ok(())
    });
    let service = service.ok_or("managed startup did not reach authenticated readiness")?;
    if !committed {
        service.gate.lock().unwrap().fenced = true;
    }
    service.finished();
    loop {
        std::thread::sleep(std::time::Duration::from_millis(250));
        if !service.begin() {
            continue;
        }
        // Each iteration reloads the same external operator config; durable run-once receipts
        // retain uncertain outcomes and never replay an unowned effect.
        let result = (|| {
            if private_bytes(std::path::Path::new(path))? != pinned_config {
                return Err("managed operator config changed");
            }
            let config = read_config(std::path::Path::new(path))?;
            canaveral_apple_satellite::run_once_with_ready(config, || Ok(()))
        })();
        if result.is_err() {
            eprintln!("managed runner iteration requires contact or retained-state reconciliation");
        }
        service.finished();
    }
}
#[cfg(not(unix))]
fn run() -> Result<(), &'static str> {
    Err("canaveral-apple-satellite supports only macOS hosts")
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(unix)]
fn private_bytes(path: &std::path::Path) -> Result<Vec<u8>, &'static str> {
    use std::os::unix::fs::MetadataExt;
    if !path.is_absolute() {
        return Err("absolute private config required");
    }
    for parent in path.ancestors() {
        if std::fs::symlink_metadata(parent)
            .map_err(|_| "private file unavailable")?
            .file_type()
            .is_symlink()
        {
            return Err("linked config rejected");
        }
    }
    let m = std::fs::metadata(path).map_err(|_| "private file unavailable")?;
    if !m.is_file()
        || m.len() > 1024 * 1024
        || m.nlink() != 1
        || m.uid() != unsafe { libc::geteuid() }
        || m.mode() & 0o077 != 0
    {
        return Err("private owned file required");
    }
    std::fs::read(path).map_err(|_| "private file unavailable")
}
#[cfg(unix)]
struct Managed {
    output: std::fs::File,
    input: std::fs::File,
    release: String,
    installation: String,
}
#[cfg(unix)]
impl Managed {
    fn open() -> Result<Self, &'static str> {
        use std::os::fd::FromRawFd;
        if std::env::var("CANAVERAL_UPDATE_CANDIDATE").as_deref() != Ok("1")
            || std::env::var("CANAVERAL_UPDATE_READY_FD").as_deref() != Ok("3")
            || std::env::var("CANAVERAL_UPDATE_COMMIT_FD").as_deref() != Ok("4")
        {
            return Err("inherited managed pipes required");
        }
        let id = |key| -> Result<String, &'static str> {
            let s = std::env::var(key).map_err(|_| "managed identity missing")?;
            let u = uuid::Uuid::parse_str(&s).map_err(|_| "invalid managed identity")?;
            if u.is_nil() || u.to_string() != s {
                return Err("invalid managed identity");
            }
            Ok(s)
        };
        Ok(Self {
            output: unsafe { std::fs::File::from_raw_fd(3) },
            input: unsafe { std::fs::File::from_raw_fd(4) },
            release: id("CANAVERAL_UPDATE_RELEASE")?,
            installation: id("CANAVERAL_UPDATE_INSTALLATION")?,
        })
    }
    fn ack(&mut self) -> Result<(), &'static str> {
        use std::io::Write;
        let value = serde_json::json!({"type":"canaveral-update-committed-ack","version":1,"releaseId":self.release,"installationId":self.installation});
        writeln!(self.output, "{value}")
            .and_then(|_| self.output.flush())
            .map_err(|_| "managed commit acknowledgment lost")
    }
    fn phase(&mut self, outgoing: &str, incoming: &str) -> Result<(), &'static str> {
        use std::io::{Read, Write};
        use std::os::fd::AsRawFd;
        let message = serde_json::json!({"type":outgoing,"version":1,"releaseId":self.release,"installationId":self.installation});
        writeln!(self.output, "{message}").map_err(|_| "managed readiness pipe lost")?;
        self.output
            .flush()
            .map_err(|_| "managed readiness pipe lost")?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let mut bytes = Vec::new();
        loop {
            let remaining = deadline
                .saturating_duration_since(std::time::Instant::now())
                .as_millis();
            if remaining == 0 || bytes.len() >= 4096 {
                return Err("managed command deadline or bound exceeded");
            }
            let mut fd = libc::pollfd {
                fd: self.input.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            if unsafe { libc::poll(&mut fd, 1, remaining.min(30_000) as i32) } <= 0 {
                return Err("managed command pipe unavailable");
            }
            let mut byte = [0];
            self.input
                .read_exact(&mut byte)
                .map_err(|_| "managed command pipe lost")?;
            if byte[0] == b'\n' {
                break;
            }
            bytes.push(byte[0]);
        }
        let value: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| "invalid managed command")?;
        if value
            != serde_json::json!({"type":incoming,"version":1,"releaseId":self.release,"installationId":self.installation})
        {
            return Err("managed phase or identity mismatch");
        }
        Ok(())
    }
}

#[cfg(unix)]
#[derive(Default)]
struct Admission {
    busy: bool,
    fenced: bool,
}
#[cfg(unix)]
struct Service {
    gate: std::sync::Arc<std::sync::Mutex<Admission>>,
}
#[cfg(unix)]
impl Service {
    fn begin(&self) -> bool {
        let mut gate = self.gate.lock().unwrap();
        if gate.fenced {
            return false;
        }
        gate.busy = true;
        true
    }
    fn finished(&self) {
        self.gate.lock().unwrap().busy = false;
    }
}
#[cfg(unix)]
impl Managed {
    fn service(
        &self,
        config_path: std::path::PathBuf,
        pinned_config: Vec<u8>,
    ) -> Result<Service, &'static str> {
        use std::io::{BufRead, Write};
        let mut input = std::io::BufReader::new(
            self.input
                .try_clone()
                .map_err(|_| "managed command pipe lost")?,
        );
        let mut output = self
            .output
            .try_clone()
            .map_err(|_| "managed reply pipe lost")?;
        let gate = std::sync::Arc::new(std::sync::Mutex::new(Admission {
            busy: true,
            fenced: false,
        }));
        let commands = gate.clone();
        std::thread::spawn(move || {
            loop {
                let mut bytes = Vec::new();
                // take limits allocation even when a peer omits the newline.
                if std::io::Read::take(&mut input, 4097)
                    .read_until(b'\n', &mut bytes)
                    .ok()
                    .is_none_or(|n| n == 0 || n > 4096)
                    || !bytes.ends_with(b"\n")
                {
                    break;
                }
                let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
                    break;
                };
                let Some(request_id) = value["requestId"].as_str().filter(|s| {
                    uuid::Uuid::parse_str(s)
                        .ok()
                        .is_some_and(|u| !u.is_nil() && u.to_string() == *s)
                }) else {
                    break;
                };
                let Some(kind) = value["type"].as_str() else {
                    break;
                };
                if value.as_object().is_none_or(|v| v.len() != 2)
                    || !["canaveral-update-status", "canaveral-update-quiesce"].contains(&kind)
                {
                    break;
                }
                let mut admission = commands.lock().unwrap();
                if kind == "canaveral-update-quiesce" {
                    admission.fenced = true;
                }
                let idle = !admission.busy
                    && private_bytes(&config_path).is_ok_and(|bytes| bytes == pinned_config)
                    && native_status(&config_path).unwrap_or(false);
                let reply = serde_json::json!({"type":"canaveral-update-status","requestId":request_id,"idle":idle,"workloadsStopped":idle,"quiesced":admission.fenced && idle});
                if writeln!(output, "{reply}")
                    .and_then(|_| output.flush())
                    .is_err()
                {
                    break;
                }
            }
            commands.lock().unwrap().fenced = true;
        });
        Ok(Service { gate })
    }
}

#[cfg(unix)]
fn native_status(path: &std::path::Path) -> Result<bool, &'static str> {
    canaveral_apple_satellite::update_status(&canaveral_apple_satellite::read_config(path)?)
}

#[cfg(all(test, unix))]
mod managed_tests {
    use super::*;
    #[test]
    fn readonly_identity_check_uses_rust_typed_checksum_and_creates_no_runtime_state() {
        use sha2::{Digest, Sha256};
        use std::os::unix::fs::PermissionsExt;
        #[derive(serde::Serialize)]
        struct Record {
            version: u8,
            origin: String,
            approval: canaveral_runner_client::Approval,
            credential: String,
            phase: String,
        }
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let identity = root.join("identity");
        std::fs::create_dir(&identity).unwrap();
        let controller_id = uuid::Uuid::from_u128(1);
        let runner_id = uuid::Uuid::from_u128(2);
        let incarnation_id = uuid::Uuid::from_u128(3);
        let record = Record {
            version: 1,
            origin: "https://controller.invalid".into(),
            approval: canaveral_runner_client::Approval {
                id: uuid::Uuid::from_u128(4),
                controller_id,
                runner_id,
                generation: 1,
                incarnation_id,
                expires_at: 3600.0,
                enrollment_token: "a".repeat(43),
            },
            credential: "b".repeat(43),
            phase: "Authenticated".into(),
        };
        let hash = format!("{:x}", Sha256::digest(serde_json::to_vec(&record).unwrap()));
        let mut envelope = serde_json::json!({"record":record,"sha256":hash});
        let path = identity.join("identity.json");
        std::fs::write(&path, envelope.to_string()).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let config: canaveral_apple_satellite::Config = serde_json::from_value(serde_json::json!({"origin":"https://controller.invalid","identity":identity,"binding":{"controllerId":controller_id,"runnerId":runner_id,"generation":1,"incarnationId":incarnation_id},"state":root.join("runtime"),"helper":root.join("helper"),"helperSha256":"0".repeat(64),"signingRequirement":"fixture","ca":null,"inventory":[],"maxCpu":1,"maxMemoryMiB":1024,"maxDiskGiB":8})).unwrap();
        assert!(check_saved_identity(&config).is_ok());
        assert!(!config.state.exists());
        envelope["record"]["credential"] = serde_json::json!("c".repeat(43));
        std::fs::write(&path, envelope.to_string()).unwrap();
        assert!(check_saved_identity(&config).is_err());
        assert!(!config.state.exists());
    }

    #[test]
    fn pipe_quiesce_fences_next_turn_and_does_not_claim_busy_work_is_stopped() {
        use std::io::{BufRead, Write};
        use std::os::{
            fd::{FromRawFd, IntoRawFd},
            unix::net::UnixStream,
        };
        let (output, peer_output) = UnixStream::pair().unwrap();
        let (input, mut peer_input) = UnixStream::pair().unwrap();
        peer_output
            .set_read_timeout(Some(std::time::Duration::from_secs(3)))
            .unwrap();
        let channel = Managed {
            output: unsafe { std::fs::File::from_raw_fd(output.into_raw_fd()) },
            input: unsafe { std::fs::File::from_raw_fd(input.into_raw_fd()) },
            release: uuid::Uuid::from_u128(1).to_string(),
            installation: uuid::Uuid::from_u128(2).to_string(),
        };
        let service = channel
            .service("/nonexistent/canaveral-fixture/config".into(), Vec::new())
            .unwrap();
        let id = uuid::Uuid::from_u128(3).to_string();
        writeln!(
            peer_input,
            "{}",
            serde_json::json!({"type":"canaveral-update-quiesce","requestId":id})
        )
        .unwrap();
        let mut reader = std::io::BufReader::new(peer_output);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let reply: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(reply["idle"], false);
        assert_eq!(reply["workloadsStopped"], false);
        assert_eq!(reply["quiesced"], false);
        assert!(service.gate.lock().unwrap().busy); // No cancellation of the current turn.
        service.finished();
        assert!(!service.begin()); // No next claim after the fence.
        drop(peer_input);
    }
}

#[cfg(unix)]
fn check_saved_identity(config: &canaveral_apple_satellite::Config) -> Result<(), &'static str> {
    use sha2::{Digest, Sha256};
    // Match runner-client's typed serialization, including f64 expiry encoding.
    // Serializing a generic JSON map would sort keys and verify different bytes.
    #[derive(serde::Serialize, serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Record {
        version: u8,
        origin: String,
        approval: canaveral_runner_client::Approval,
        credential: String,
        phase: String,
    }
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Envelope {
        record: Record,
        sha256: String,
    }
    let value: Envelope =
        serde_json::from_slice(&private_bytes(&config.identity.join("identity.json"))?)
            .map_err(|_| "invalid saved identity")?;
    let r = &value.record;
    let a = &r.approval;
    let b = &config.binding;
    let valid_secret = |s: &str| {
        (43..=128).contains(&s.len())
            && s.bytes()
                .all(|v| v.is_ascii_alphanumeric() || b"_-".contains(&v))
    };
    if format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(r).map_err(|_| "invalid saved identity")?)
    ) != value.sha256
        || r.version != 1
        || r.origin != config.origin.trim_end_matches('/')
        || !["Consumed", "Authenticated"].contains(&r.phase.as_str())
        || a.controller_id != b.controller_id
        || a.runner_id != b.runner_id
        || a.generation != b.generation
        || a.incarnation_id != b.incarnation_id
        || !valid_secret(&r.credential)
        || !valid_secret(&a.enrollment_token)
        || r.credential == a.enrollment_token
        || !a.expires_at.is_finite()
        || a.expires_at < 0.0
    {
        return Err("saved identity binding rejected");
    }
    Ok(())
}
