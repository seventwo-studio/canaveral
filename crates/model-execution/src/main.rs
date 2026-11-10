#[cfg(unix)]
fn run() -> Result<(), &'static str> {
    use canaveral_model_execution::controller::{RunnerConfig, run_once, run_once_with_ready};
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
    } else if (check || status) && args.len() == 2 {
        (&args[1], None)
    } else if args.len() == 1 {
        (&args[0], None)
    } else {
        return Err(
            "expected CONFIG, --update-check CONFIG, or --update-managed --config CONFIG --state STATE",
        );
    };
    let bytes = if check || status || managed {
        private_bytes(std::path::Path::new(path))?
    } else {
        std::fs::read(path).map_err(|_| "configuration unavailable")?
    };
    let config: RunnerConfig =
        serde_json::from_slice(&bytes).map_err(|_| "invalid configuration")?;
    if !check && !status && !managed {
        return run_once(config);
    }
    if state.is_some_and(|s| std::path::Path::new(s) != config.execution.state_dir) {
        return Err("managed state binding mismatch");
    }
    let secret = private_bytes(&config.credential_file)?;
    let credential = std::str::from_utf8(&secret)
        .map_err(|_| "invalid credential")?
        .trim();
    if !(43..=128).contains(&credential.len())
        || !credential
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        || config.binding.generation == 0
        || config.binding.controller_id.is_nil()
        || config.binding.runner_id.is_nil()
        || config.binding.incarnation_id.is_nil()
    {
        return Err("invalid saved binding");
    }
    let url = reqwest::Url::parse(&config.controller).map_err(|_| "invalid controller")?;
    if url.scheme() != "https"
        && !(url.scheme() == "http"
            && url
                .host_str()
                .and_then(|s| s.parse::<std::net::IpAddr>().ok())
                .is_some_and(|ip| ip.is_loopback()))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("invalid controller trust");
    }
    if let Some(path) = &config.ca_file {
        let ca = private_bytes(path)?;
        if reqwest::Certificate::from_pem_bundle(&ca)
            .map_err(|_| "invalid CA")?
            .is_empty()
        {
            return Err("invalid CA");
        }
    }
    if status {
        let idle = canaveral_model_execution::controller::update_status(&config).unwrap_or(false);
        println!("{}", serde_json::json!({"type":"canaveral-update-status","version":1,"binding":config.binding,"idle":idle,"workloadsStopped":idle,"quiesced":idle}));
        return Ok(());
    }
    if check {
        println!("{{\"type\":\"canaveral-update-check\",\"version\":1,\"runtime\":\"model\"}}");
        return Ok(());
    }
    let mut channel = Managed::open()?;
    channel.phase("canaveral-update-ready", "canaveral-update-activate")?;
    let mut service = None;
    let _result = run_once_with_ready(config, || {
        channel.phase("canaveral-update-started", "canaveral-update-committed")?;
        service = Some(channel.service(std::path::PathBuf::from(path))?);
        Ok(())
    });
    let service = service.ok_or("managed startup did not reach authenticated readiness")?;
    service.finished();
    loop {
        std::thread::sleep(std::time::Duration::from_millis(250));
        if !service.begin() { continue; }
        // Each iteration reloads the same external operator config; durable run-once receipts
        // retain uncertain outcomes and never replay an unowned effect.
        let result = (|| {
            let config = serde_json::from_slice(&private_bytes(std::path::Path::new(path))?).map_err(|_| "invalid configuration")?;
            canaveral_model_execution::controller::run_once(config)
        })();
        if result.is_err() { eprintln!("managed runner iteration requires contact or retained-state reconciliation"); }
        service.finished();
    }
}
#[cfg(unix)]
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
#[cfg(not(unix))]
fn main() {
    eprintln!("owned Ollama execution is unsupported on this platform");
    std::process::exit(1);
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
struct Admission { busy: bool, fenced: bool }
#[cfg(unix)]
struct Service { gate: std::sync::Arc<std::sync::Mutex<Admission>> }
#[cfg(unix)]
impl Service {
    fn begin(&self) -> bool { let mut gate = self.gate.lock().unwrap(); if gate.fenced { return false; } gate.busy = true; true }
    fn finished(&self) { self.gate.lock().unwrap().busy = false; }
}
#[cfg(unix)]
impl Managed {
    fn service(&self, config_path: std::path::PathBuf) -> Result<Service, &'static str> {
        use std::io::{BufRead, Write};
        let mut input = std::io::BufReader::new(self.input.try_clone().map_err(|_| "managed command pipe lost")?);
        let mut output = self.output.try_clone().map_err(|_| "managed reply pipe lost")?;
        let gate = std::sync::Arc::new(std::sync::Mutex::new(Admission { busy: true, fenced: false }));
        let commands = gate.clone();
        std::thread::spawn(move || {
            loop {
                let mut bytes = Vec::new();
                // take limits allocation even when a peer omits the newline.
                if std::io::Read::take(&mut input, 4097).read_until(b'\n', &mut bytes).ok().is_none_or(|n| n == 0 || n > 4096) || !bytes.ends_with(b"\n") { break; }
                let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else { break; };
                let Some(request_id) = value["requestId"].as_str().filter(|s| uuid::Uuid::parse_str(s).ok().is_some_and(|u| !u.is_nil() && u.to_string() == *s)) else { break; };
                let Some(kind) = value["type"].as_str() else { break; };
                if value.as_object().is_none_or(|v| v.len() != 2) || !["canaveral-update-status", "canaveral-update-quiesce"].contains(&kind) { break; }
                let mut admission = commands.lock().unwrap();
                if kind == "canaveral-update-quiesce" { admission.fenced = true; }
                let idle = !admission.busy && native_status(&config_path).unwrap_or(false);
                let reply = serde_json::json!({"type":"canaveral-update-status","requestId":request_id,"idle":idle,"workloadsStopped":idle,"quiesced":admission.fenced && idle});
                if writeln!(output, "{reply}").and_then(|_| output.flush()).is_err() { break; }
            }
            commands.lock().unwrap().fenced = true;
        });
        Ok(Service { gate })
    }
}

#[cfg(unix)]
fn native_status(path: &std::path::Path) -> Result<bool, &'static str> {
    let config = serde_json::from_slice(&private_bytes(path)?).map_err(|_| "invalid configuration")?;
    canaveral_model_execution::controller::update_status(&config)
}
