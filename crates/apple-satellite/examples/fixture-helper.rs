//! Fixture-only stand-in for CanaveralVMRunner. It starts no VM. It mirrors the native CLI
//! schemas the satellite uses (check, lease-clock, prepare, inspect, run) and the native
//! lease guard, so integration fixtures exercise the real satellite against a real controller.
//! Every invocation appends its action to `calls.log` beside the executable.
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
        let image = PathBuf::from(r["image"].as_str().ok_or("image")?);
        let folder = PathBuf::from(r["directory"].as_str().ok_or("directory")?).join(&id);
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
        let _disk = OpenOptions::new()
            .read(true)
            .write(true)
            .open(dir.join("disk.img"))
            .map_err(fail)?;
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
        write(
            dir.join("fixture-running"),
            std::process::id().to_string().as_bytes(),
        )?;
        loop {
            if let Some(request) = read_json(&dir.join("power-off.request")) {
                if request["boot"].as_f64() == Some(attempted) {
                    return Ok(());
                }
            }
            if !guard.observe(read_json(&dir.join("lease-authorization.json")), now()) {
                return fence(dir, &guard);
            }
            std::thread::sleep(Duration::from_millis(50));
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
        let exe = std::env::current_exe().map_err(fail)?;
        if let Some(parent) = exe.parent() {
            let mut log = OpenOptions::new()
                .append(true)
                .create(true)
                .mode(0o600)
                .open(parent.join("calls.log"))
                .map_err(fail)?;
            writeln!(log, "{action}").map_err(fail)?;
        }
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
