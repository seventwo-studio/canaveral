//! Fixture-only stand-in for CanaveralVMRunner. It starts no VM. It mirrors the native CLI
//! schemas the satellite uses (check, lease-clock, prepare, inspect, run) and the native
//! lease guard, so integration fixtures exercise the real satellite against a real controller.
//! Every invocation appends its action to `calls.log` beside the executable.
//!
//! Direct boot: `prepare` checks the pinned DirectBoot files like the native helper and
//! records the request as `prepare-MEMBER.json` beside the executable; `run` consumes the
//! attempt receipt, publishes the private relay socket and `direct-started.json`, and answers
//! as a protocol-faithful guest PID1 bound to the simulated medium's launch.json. A
//! `guest-mode` file beside the executable selects `ready` (default), `stall`,
//! `wrong-identity` or `wrong-version`. A received exec is logged as `exec`; none is run.
#[cfg(unix)]
mod fixture {
    use serde_json::{json, Value};
    use std::{
        fs::{File, OpenOptions},
        io::{Read, Write},
        os::{
            fd::AsRawFd,
            unix::fs::{DirBuilderExt, OpenOptionsExt},
        },
        path::{Path, PathBuf},
        time::Duration,
    };
    type Result<T> = std::result::Result<T, String>;
    fn fail<E: std::fmt::Display>(e: E) -> String {
        e.to_string()
    }
    fn now() -> f64 {
        canaveral_apple_satellite::clock::now().as_secs_f64()
    }
    #[cfg(target_os = "macos")]
    fn boot_session() -> Result<String> {
        let mut bytes = [0u8; 128];
        let mut length = bytes.len();
        let name = c"kern.bootsessionuuid";
        if unsafe {
            libc::sysctlbyname(
                name.as_ptr(),
                bytes.as_mut_ptr().cast(),
                &mut length,
                std::ptr::null_mut(),
                0,
            )
        } != 0
        {
            return Err("boot identity unavailable".into());
        }
        let text = String::from_utf8_lossy(&bytes[..length]);
        Ok(text.trim_end_matches('\0').to_owned())
    }
    #[cfg(not(target_os = "macos"))]
    fn boot_session() -> Result<String> {
        Ok(std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
            .map_err(fail)?
            .trim()
            .to_owned())
    }
    fn read_json(path: &Path) -> Option<Value> {
        let mut bytes = Vec::new();
        File::open(path)
            .ok()?
            .take(4097)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.is_empty() || bytes.len() > 4096 {
            return None;
        }
        serde_json::from_slice(&bytes).ok()
    }
    fn lock(dir: &Path) -> Result<(File, bool)> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(dir.join("runtime.lock"))
            .map_err(fail)?;
        let held = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0;
        Ok((file, held))
    }
    /// Same rules as the native LeaseExecutionGuard: sticky fence, expiry before renewal.
    struct Guard {
        machine: String,
        lease: String,
        boot: f64,
        session: String,
        revision: u64,
        deadline: Option<f64>,
    }
    impl Guard {
        fn observe(&mut self, value: Option<Value>, now: f64) -> bool {
            if let Some(deadline) = self.deadline {
                if now >= deadline {
                    return false;
                }
            }
            let Some(v) = value else { return false };
            let same = |key: &str, want: &str| {
                v[key]
                    .as_str()
                    .is_some_and(|s| s.eq_ignore_ascii_case(want))
            };
            let revision = v["revision"].as_u64().unwrap_or(0);
            let deadline = v["deadline"].as_f64().unwrap_or(f64::NAN);
            if v["version"] != 1
                || !same("machineID", &self.machine)
                || !same("leaseID", &self.lease)
                || v["boot"].as_f64() != Some(self.boot)
                || !same("bootSessionID", &self.session)
                || revision < 1
                || !deadline.is_finite()
                || v["fenced"] != false
            {
                return false;
            }
            if revision >= self.revision {
                match self.deadline {
                    Some(previous) if revision == self.revision => {
                        self.deadline = Some(previous.min(deadline))
                    }
                    _ => {
                        self.deadline = Some(deadline);
                        self.revision = revision;
                    }
                }
            }
            self.deadline.is_some_and(|d| now < d)
        }
    }
    fn helper_dir() -> Result<PathBuf> {
        Ok(std::env::current_exe()
            .map_err(fail)?
            .parent()
            .ok_or("helper directory")?
            .to_owned())
    }
    fn log(action: &str) -> Result<()> {
        let mut log = OpenOptions::new()
            .append(true)
            .create(true)
            .mode(0o600)
            .open(helper_dir()?.join("calls.log"))
            .map_err(fail)?;
        writeln!(log, "{action}").map_err(fail)
    }
    /// Mirrors the native PinnedBootFile rules the fixture can observe.
    fn verify_pin(pin: &Value) -> Result<PathBuf> {
        use sha2::Digest;
        use std::os::unix::fs::MetadataExt;
        let path = PathBuf::from(pin["path"].as_str().ok_or("pin path")?);
        let meta = std::fs::symlink_metadata(&path).map_err(fail)?;
        #[cfg(target_os = "macos")]
        let immutable = std::os::macos::fs::MetadataExt::st_flags(&meta)
            & (libc::UF_IMMUTABLE | libc::SF_IMMUTABLE)
            != 0;
        #[cfg(not(target_os = "macos"))]
        let immutable = false;
        let bytes = std::fs::read(&path).map_err(fail)?;
        if !path.is_absolute()
            || !meta.is_file()
            || meta.nlink() != 1
            || meta.mode() & 0o7777 != 0o400
            || !immutable
            || Some(bytes.len() as u64) != pin["size"].as_u64()
            || format!("{:x}", sha2::Sha256::digest(&bytes)) != pin["sha256"]
        {
            return Err("Artifact must be private, immutable, mode 0400 and pinned.".into());
        }
        Ok(path)
    }
    fn write(path: PathBuf, body: &[u8]) -> Result<()> {
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .map_err(fail)?;
        f.write_all(body).map_err(fail)?;
        f.sync_all().map_err(fail)
    }
    fn prepare() -> Result<()> {
        let mut input = Vec::new();
        std::io::stdin()
            .take(65537)
            .read_to_end(&mut input)
            .map_err(fail)?;
        if input.len() > 65536 {
            return Err("preparation request too large".into());
        }
        let r: Value = serde_json::from_slice(&input).map_err(fail)?;
        let id = r["id"].as_str().ok_or("id")?.to_uppercase();
        let memory = r["memoryMiB"].as_u64().ok_or("memoryMiB")?;
        let disk = r["diskGiB"].as_u64().ok_or("diskGiB")?;
        let cpu = r["cpu"].as_u64().ok_or("cpu")?;
        if r["os"] != "linux"
            || r["mode"] != "headless"
            || r["leaseID"].as_str().is_none()
            || r["name"].as_str().is_none_or(str::is_empty)
            || !(1..=64).contains(&cpu)
            || memory == 0
            || memory % 1024 != 0
            || !(4..=1024).contains(&disk)
        {
            return Err("unsupported preparation".into());
        }
        let folder = PathBuf::from(r["directory"].as_str().ok_or("directory")?).join(&id);
        if let Some(boot) = r.get("directBoot") {
            if r.get("image").is_some()
                || boot["version"] != 1
                || boot["initrd"].is_null()
                || boot["memberID"].as_str().map(str::to_uppercase) != Some(id.clone())
                || boot["leaseID"] != r["leaseID"]
                || boot["bootAttempt"] != boot["launchFilesystemUUID"]
                || boot["bootSessionID"].as_str().map(str::to_uppercase)
                    != Some(boot_session()?.to_uppercase())
            {
                return Err("Invalid direct boot v1 inventory or launch binding.".into());
            }
            for role in ["kernel", "initrd", "rootfs", "launchMedium"] {
                verify_pin(&boot[role])?;
            }
            write(helper_dir()?.join(format!("prepare-{id}.json")), &input)?;
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(&folder)
                .map_err(|_| "This machine already exists.")?;
            write(
                folder.join("machine.json"),
                json!({"id":id,"executionLeaseID":r["leaseID"],"cpuCount":cpu,"memoryGiB":memory/1024,
                    "diskGiB":disk,"directBoot":boot})
                .to_string()
                .as_bytes(),
            )?;
            write(folder.join("native-prepared"), b"prepared\n")?;
            println!("Prepared {id}");
            return Ok(());
        }
        let image = PathBuf::from(r["image"].as_str().ok_or("image")?);
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&folder)
            .map_err(|_| "This machine already exists.")?;
        let source = std::fs::read(&image).map_err(fail)?;
        write(folder.join("disk.img"), &source)?;
        write(folder.join("efi.bin"), b"fixture variable store")?;
        // Stands in for guest credential material that cleanup must erase with the workspace.
        write(
            folder.join("guest-credential"),
            b"fixture-only guest secret",
        )?;
        write(
            folder.join("machine.json"),
            json!({"id":id,"executionLeaseID":r["leaseID"],"cpuCount":cpu,"memoryGiB":memory/1024,"diskGiB":disk})
                .to_string()
                .as_bytes(),
        )?;
        write(folder.join("native-prepared"), b"prepared\n")?;
        println!("Prepared {id}");
        Ok(())
    }
    fn run(dir: &Path) -> Result<()> {
        let launch = read_json(&dir.join("runner-launch.json")).ok_or("launch identity missing")?;
        let attempted = launch["attemptedAt"].as_f64().ok_or("launch identity")?;
        let machine = read_json(&dir.join("machine.json")).ok_or("machine missing")?;
        let (_lock, held) = lock(dir)?;
        if held {
            return Err("runtime already locked".into());
        }
        let direct = machine.get("directBoot").cloned();
        let _disk = if let Some(boot) = &direct {
            // Exclusive per-directory attempt receipt, as the native helper keeps.
            let attempt = boot["bootAttempt"]
                .as_str()
                .ok_or("attempt")?
                .to_lowercase();
            write(dir.join(format!("direct-attempt-{attempt}")), b"")
                .map_err(|_| "Direct boot attempt consumed or unavailable.")?;
            for role in ["kernel", "initrd", "rootfs", "launchMedium"] {
                verify_pin(&boot[role])?;
            }
            // Read-only attachments hold the shared rootfs and the owned launch medium.
            File::open(boot["launchMedium"]["path"].as_str().ok_or("medium")?).map_err(fail)?
        } else {
            OpenOptions::new()
                .read(true)
                .write(true)
                .open(dir.join("disk.img"))
                .map_err(fail)?
        };
        let _rootfs = match &direct {
            Some(boot) => {
                Some(File::open(boot["rootfs"]["path"].as_str().ok_or("rootfs")?).map_err(fail)?)
            }
            None => None,
        };
        let mut guard = Guard {
            machine: machine["id"].as_str().ok_or("id")?.to_owned(),
            lease: machine["executionLeaseID"]
                .as_str()
                .ok_or("lease")?
                .to_owned(),
            boot: attempted,
            session: boot_session()?,
            revision: 0,
            deadline: None,
        };
        if !guard.observe(read_json(&dir.join("lease-authorization.json")), now()) {
            return fence(dir, &guard);
        }
        let relay = match &direct {
            Some(boot) => Some(relay::start(dir, boot, &guard.session)?),
            None => None,
        };
        write(
            dir.join("fixture-running"),
            std::process::id().to_string().as_bytes(),
        )?;
        loop {
            if let Some(request) = read_json(&dir.join("power-off.request")) {
                if request["boot"].as_f64() == Some(attempted) {
                    // Like the native relay stop: remove the private socket directory.
                    if let Some(relay) = &relay {
                        let _ = std::fs::remove_dir_all(relay);
                    }
                    return Ok(());
                }
            }
            if !guard.observe(read_json(&dir.join("lease-authorization.json")), now()) {
                return fence(dir, &guard);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    /// Helper relay plus guest PID1 stand-in on one private socket.
    mod relay {
        use super::{fail, log, now, Result};
        use canaveral_guest_protocol::{bundle::Launch, encode, Decoder, Guest, Host};
        use serde_json::{json, Value};
        use std::{
            io::{Read, Write},
            os::unix::{fs::PermissionsExt, net::UnixListener},
            path::{Path, PathBuf},
        };
        const LABEL: &[u8] = b"CANAVERAL-SIMULATED-EROFS-NOT-MOUNTABLE\n";
        fn launch(boot: &Value) -> Result<Launch> {
            let bytes = std::fs::read(boot["launchMedium"]["path"].as_str().ok_or("medium")?)
                .map_err(fail)?;
            if bytes.get(1024..1028) != Some(&[0xe2, 0xe1, 0xf5, 0xe0][..]) {
                return Err("launch medium is not EROFS".into());
            }
            let at = bytes
                .windows(LABEL.len())
                .position(|w| w == LABEL)
                .ok_or("not a simulated fixture medium")?;
            let launch: Launch =
                serde_json::from_slice(&bytes[at + LABEL.len()..]).map_err(fail)?;
            launch.validate().map_err(fail)?;
            let b = &launch.binding;
            let same = |key: &str, id: uuid::Uuid| {
                boot[key]
                    .as_str()
                    .and_then(|s| uuid::Uuid::parse_str(s).ok())
                    == Some(id)
            };
            // Guest-side equivalents of the serial/nonce and launch.json binding checks.
            if !same("bootAttempt", b.boot_attempt)
                || !same("memberID", b.member_id)
                || !same("leaseID", b.lease_id)
                || boot["bundleDigest"] != b.bundle_digest.as_str()
            {
                return Err("launch medium provenance mismatch".into());
            }
            Ok(launch)
        }
        pub fn start(dir: &Path, boot: &Value, session: &str) -> Result<PathBuf> {
            let launch = launch(boot)?;
            let mut id = [0u8; 16];
            getrandom::fill(&mut id).map_err(fail)?;
            let relay = PathBuf::from(format!(
                "{}/canaveral-{}",
                canaveral_apple_satellite::guest::SOCKET_ROOT,
                uuid::Uuid::from_bytes(id)
            ));
            std::fs::create_dir(&relay).map_err(fail)?;
            std::fs::set_permissions(&relay, std::fs::Permissions::from_mode(0o700))
                .map_err(fail)?;
            let socket = relay.join("agent.sock");
            let listener = UnixListener::bind(&socket).map_err(fail)?;
            std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))
                .map_err(fail)?;
            let upper = |key: &str| boot[key].as_str().unwrap_or_default().to_uppercase();
            let started = json!({"event":"started","version":1,"continuous":now(),
                "memberID":upper("memberID"),"leaseID":upper("leaseID"),
                "bootSessionID":session.to_uppercase(),"bootAttempt":upper("bootAttempt"),
                "agentSocket":socket});
            let next = dir.join("direct-started.next");
            super::write(next.clone(), started.to_string().as_bytes())?;
            std::fs::rename(next, dir.join("direct-started.json")).map_err(fail)?;
            let mode = std::fs::read_to_string(super::helper_dir()?.join("guest-mode"))
                .unwrap_or_else(|_| "ready".into());
            std::thread::spawn(move || {
                // Exactly one authorized stream; foreign-uid peers leave the listener open.
                for stream in listener.incoming() {
                    let Ok(stream) = stream else { return };
                    if canaveral_apple_satellite::guest::peer_uid(&stream)
                        != Some(unsafe { libc::geteuid() })
                    {
                        continue;
                    }
                    let _ = guest(stream, &launch, mode.trim());
                    return;
                }
            });
            Ok(relay)
        }
        fn guest(
            mut stream: std::os::unix::net::UnixStream,
            launch: &Launch,
            mode: &str,
        ) -> Result<()> {
            let mut decoder = Decoder::default();
            let mut buf = [0u8; 4096];
            let mut revision = 0;
            loop {
                let want = decoder.needed().min(buf.len());
                let n = stream.read(&mut buf[..want]).map_err(fail)?;
                if n == 0 {
                    return Ok(());
                }
                let Some(frame) = decoder.feed(&buf[..n]).map_err(fail)? else {
                    continue;
                };
                match frame {
                    Host::Hello { binding, .. } if revision == 0 => {
                        if binding != launch.binding {
                            return Err("launch binding mismatch".into());
                        }
                        revision = binding.revision;
                        let mut echo = binding;
                        let version = match mode {
                            "stall" => continue,
                            "wrong-version" => 2,
                            "wrong-identity" => {
                                echo.member_id = uuid::Uuid::from_u128(1);
                                1
                            }
                            _ => 1,
                        };
                        log("guest-ready")?;
                        let frame = encode(&Guest::Ready {
                            version,
                            binding: echo,
                        })
                        .map_err(fail)?;
                        stream.write_all(&frame).map_err(fail)?;
                    }
                    Host::Renew { binding, .. }
                        if revision != 0
                            && binding.same_launch(&launch.binding)
                            && binding.revision > revision =>
                    {
                        revision = binding.revision;
                        log("guest-renew")?;
                    }
                    Host::Exec { .. } => {
                        log("exec")?;
                        return Err("fixture guest never executes".into());
                    }
                    _ => return Err("invalid session transition".into()),
                }
            }
        }
    }
    fn fence(dir: &Path, guard: &Guard) -> Result<()> {
        let _ = write(
            dir.join("lease-fenced.json"),
            json!({"machineID":guard.machine,"revision":guard.revision,"fencedAt":now(),
                "reason":"lease-authorization-ended"})
            .to_string()
            .as_bytes(),
        );
        std::process::exit(70)
    }
    pub fn main() -> Result<()> {
        let args: Vec<String> = std::env::args().collect();
        let action = args.get(1).cloned().unwrap_or_default();
        log(&action)?;
        match (action.as_str(), args.get(2)) {
            ("check", None) => println!("Apple virtualization available (fixture helper)"),
            ("lease-clock", None) => println!(
                "{}",
                json!({"version":1,"bootSessionID":boot_session()?,"continuous":now()})
            ),
            ("prepare", None) => prepare()?,
            ("inspect", Some(dir)) => {
                let (_file, held) = lock(Path::new(dir))?;
                println!("{}", json!({ "locked": held }));
            }
            ("run", Some(dir)) => run(Path::new(dir))?,
            _ => return Err("Unknown runner command.".into()),
        }
        Ok(())
    }
}
fn main() {
    #[cfg(unix)]
    let result = fixture::main();
    #[cfg(not(unix))]
    let result: Result<(), String> = Err("fixture helper requires a Unix host".into());
    if let Err(e) = result {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
