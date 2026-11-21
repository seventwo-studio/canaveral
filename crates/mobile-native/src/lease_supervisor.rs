//! Independent deadline owner for one leased Android emulator or iOS simulator.
//!
//! The host publishes `lease-authorization.json` with an absolute deadline on this
//! boot's continuous clock. This process owns the emulator's dedicated process
//! group and stops it when that deadline passes, the authorization is fenced,
//! missing or changed, or this process is asked to terminate. It keeps running
//! when the host runner or controller is lost. Only a confirmed absent process
//! group produces `lease-stopped.json`; nothing else is a stop proof.
//!
//! The supervisor holds an exclusive `flock` on `lease-supervisor.lock` for its whole
//! life, so the host can prove it is gone without trusting a PID. It exits with
//! `REFUSED` only when it spawned nothing; every path after spawn stops the group first.
//!
//! A leased iOS simulator adds a second owned thing. The supervised child is then the
//! lease's own device-control companion, in its process group as above. The simulator
//! itself is booted and shut down through `simctl --set <device set>`: CoreSimulator
//! starts it through launchd, so it is never this process's child. Its stop proof is
//! the absence of the device set's process tree (see `simulator_tree`), recorded as
//! `treeAbsent` beside `groupAbsent`. Native acceptance of that proof is open.
use crate::simulator_tree::{inventory, Tree};
use serde_json::{json, Value};
use std::ffi::CString;
use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
static TERMINATE: AtomicBool = AtomicBool::new(false);
const AUTHORIZATION: &str = "lease-authorization.json";
const SUPERVISOR: &str = "lease-supervisor.json";
const FENCED: &str = "lease-fenced.json";
const STOPPED: &str = "lease-stopped.json";
const LOCK: &str = "lease-supervisor.lock";
/// Simulator tree members recorded while their parents were alive.
const TREE: &str = "lease-tree.json";
/// The private device set is always this directory of the assignment's storage.
const DEVICE_SET: &str = "device-set";
/// How long `simctl boot` and `simctl shutdown` may run before their group is killed.
const BOOT_LIMIT: Duration = Duration::from_secs(120);
const SHUTDOWN_LIMIT: Duration = Duration::from_secs(30);
/// After `simctl shutdown` returns, surviving tree members get this long before SIGKILL.
const TREE_GRACE: Duration = Duration::from_secs(5);
/// A booted simulator whose tree never appears within this window is treated as gone.
const START_WINDOW: Duration = Duration::from_secs(30);
/// The tree is sampled on every this many 100 ms supervision ticks.
const SAMPLE_TICKS: u32 = 20;
/// Exit status that proves no emulator was spawned. Any other status is not that proof.
pub const REFUSED: i32 = 75;
/// The emulator log keeps at most this many bytes per launch.
const LOG_LIMIT: u64 = 16 << 20;

extern "C" fn terminate(_: libc::c_int) {
    TERMINATE.store(true, Ordering::SeqCst);
}

fn uuid(value: &Value, key: &str) -> Result<String> {
    let text = value[key].as_str().ok_or("Missing identity")?;
    let valid = text.len() == 36
        && text.char_indices().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == '-'
            } else {
                c.is_ascii_digit() || ('a'..='f').contains(&c)
            }
        });
    if !valid {
        return Err("Invalid identity".into());
    }
    Ok(text.to_owned())
}

/// Boot session identity, read the same way as the host's native lease clock.
pub fn boot_session() -> Result<String> {
    #[cfg(target_os = "linux")]
    let raw = std::fs::read_to_string("/proc/sys/kernel/random/boot_id")?;
    #[cfg(target_os = "macos")]
    let raw = {
        let name = CString::new("kern.bootsessionuuid")?;
        let mut buffer = [0u8; 64];
        let mut size = buffer.len();
        if unsafe {
            libc::sysctlbyname(
                name.as_ptr(),
                buffer.as_mut_ptr().cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        } != 0
        {
            return Err(io::Error::last_os_error().into());
        }
        String::from_utf8(
            buffer[..size]
                .iter()
                .copied()
                .take_while(|b| *b != 0)
                .collect(),
        )?
    };
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let raw: String = return Err("Boot session unsupported".into());
    let value = raw.trim().to_ascii_lowercase();
    uuid(&json!({ "id": value }), "id")?;
    if value == "00000000-0000-0000-0000-000000000000" {
        return Err("Invalid boot session".into());
    }
    Ok(value)
}

fn read_bounded(dir: &Path, name: &str) -> Result<Option<Value>> {
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(dir.join(name))
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let meta = file.metadata()?;
    if !meta.is_file() || meta.len() > 65536 {
        return Err("Expected a bounded regular record".into());
    }
    let mut data = Vec::new();
    file.take(65537).read_to_end(&mut data)?;
    if data.len() > 65536 {
        return Err("Record exceeds its envelope".into());
    }
    Ok(Some(serde_json::from_slice(&data)?))
}

fn save(dir: &Path, name: &str, value: &Value) -> Result<()> {
    let temporary = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    let _ = std::fs::remove_file(&temporary);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&temporary)?;
    file.write_all(serde_json::to_string(value)?.as_bytes())?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&temporary, dir.join(name))?;
    File::open(dir)?.sync_all()?;
    Ok(())
}

#[derive(Clone, Debug, PartialEq)]
pub struct Authorization {
    pub revision: u64,
    pub deadline: f64,
    pub fenced: bool,
}

/// The current owner's authorization; any mismatch is a fence, never a pause.
pub fn authorization(value: &Value, identity: &Value, session: &str) -> Result<Authorization> {
    if value["version"] != 1 {
        return Err("Unsupported authorization".into());
    }
    for key in ["machineId", "leaseId", "bootId"] {
        if uuid(value, key)? != uuid(identity, key)? {
            return Err("Authorization belongs to another assignment".into());
        }
    }
    if uuid(value, "bootSessionID")? != session {
        return Err("Authorization belongs to another boot".into());
    }
    let revision = value["revision"]
        .as_u64()
        .filter(|r| *r >= 1)
        .ok_or("Invalid revision")?;
    let deadline = value["deadline"]
        .as_f64()
        .filter(|d| d.is_finite() && *d >= 0.0)
        .ok_or("Invalid deadline")?;
    let fenced = value["fenced"].as_bool().ok_or("Invalid fence")?;
    Ok(Authorization {
        revision,
        deadline,
        fenced,
    })
}

/// Same or stale revisions never extend time; a renewal first seen after expiry is ignored.
pub fn advance(current: &Authorization, next: &Authorization, now: f64) -> Authorization {
    let fenced = current.fenced || next.fenced;
    if next.revision > current.revision && now < current.deadline {
        Authorization {
            revision: next.revision,
            deadline: next.deadline,
            fenced,
        }
    } else if next.revision == current.revision {
        Authorization {
            revision: current.revision,
            deadline: current.deadline.min(next.deadline),
            fenced,
        }
    } else {
        Authorization {
            fenced,
            ..current.clone()
        }
    }
}

fn private_directory(path: &str) -> Result<PathBuf> {
    let dir = PathBuf::from(path);
    let meta = std::fs::symlink_metadata(&dir)?;
    if !dir.is_absolute()
        || !meta.is_dir()
        || std::fs::canonicalize(&dir)? != dir
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
    {
        return Err("Supervisor storage must be a private real directory".into());
    }
    Ok(dir)
}

fn lock_file(dir: &Path, create: bool) -> io::Result<File> {
    // std opens with O_CLOEXEC, so the emulator never inherits the lock.
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    if create {
        options.write(true).create(true).mode(0o600);
    }
    let file = options.open(dir.join(LOCK))?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("Supervisor lock must be regular"));
    }
    Ok(file)
}

fn try_lock(file: &File) -> io::Result<bool> {
    loop {
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(true);
        }
        let error = io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::EINTR) => continue,
            Some(code) if code == libc::EWOULDBLOCK || code == libc::EAGAIN => return Ok(false),
            _ => return Err(error),
        }
    }
}

/// Whether a live supervisor holds this storage's lifetime lock. The kernel drops the
/// lock when the supervisor process ends, however it ends, so a free lock is positive
/// proof that no supervisor for this storage is running; PIDs are never consulted.
pub fn status(path: &str) -> Result<&'static str> {
    let dir = PathBuf::from(path);
    if !dir.is_absolute() {
        return Err("Supervisor storage must be absolute".into());
    }
    let file = match lock_file(&dir, false) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok("absent"),
        Err(error) => return Err(error.into()),
    };
    // A successful probe releases the lock when `file` closes on return.
    Ok(if try_lock(&file)? { "free" } else { "held" })
}

struct Group {
    child: Child,
    pgid: i32,
}
impl Group {
    fn exited(&self) -> Result<bool> {
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        if unsafe {
            libc::waitid(
                libc::P_PID,
                self.child.id() as libc::id_t,
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        } != 0
        {
            return Err(io::Error::last_os_error().into());
        }
        Ok(unsafe { info.assume_init().si_pid() } == self.child.id() as i32)
    }
    /// An error is "not yet exited": the stop loop keeps signalling rather than returning.
    fn exited_now(&self) -> bool {
        self.exited().unwrap_or(false)
    }
    fn absent(&self) -> bool {
        (unsafe { libc::kill(-self.pgid, 0) }) < 0
            && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }
    /// Infallible: it returns only after the leader is reaped and the whole group is
    /// absent. The leader stays an unreaped child until every signal is sent, so the
    /// PGID cannot be recycled. After reaping, the group is only observed.
    fn stop(&mut self, grace: Duration) -> i32 {
        if !self.exited_now() {
            unsafe { libc::kill(-self.pgid, libc::SIGTERM) };
            let deadline = Instant::now() + grace;
            while Instant::now() < deadline && !self.exited_now() {
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        loop {
            unsafe { libc::kill(-self.pgid, libc::SIGKILL) };
            if self.exited_now() {
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        let status = loop {
            match self.child.wait() {
                Ok(status) => break status.code().unwrap_or(-1),
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                // waitid already observed the exit; nothing else can reap our own child.
                Err(_) => break -1,
            }
        };
        // Never exit while a group member may survive: a supervisor that returns has
        // nothing it launched left in the group.
        while !self.absent() {
            std::thread::sleep(Duration::from_millis(20));
        }
        status
    }
}

/// One leased iOS simulator in the lease's private device set. It is never a child of
/// this process: `simctl` asks CoreSimulator to boot and shut it down, and the process
/// table is the only evidence that it is gone.
pub struct Simulator {
    tool: Vec<String>,
    set: String,
    udid: String,
    environment: Vec<(String, String)>,
    cwd: PathBuf,
    log: Option<File>,
    tree: Tree,
}

/// What the simulator stop established. `absent` is false only when more members were
/// alive at once than the tree could record; the visible tree is gone either way.
struct TreeStop {
    absent: bool,
    forced: bool,
    shutdown: Option<i32>,
}

impl Simulator {
    /// Validated before anything is spawned. The device set is always the storage's own
    /// `device-set` directory, so this process can never act on another device set.
    fn parse(value: &Value, dir: &Path, environment: &[(String, String)]) -> Result<Self> {
        let tool = value["tool"].as_array().ok_or("Missing simulator tool")?;
        let tool = tool
            .iter()
            .map(|part| part.as_str().map(str::to_owned).ok_or("Invalid tool"))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        if tool.is_empty()
            || tool.len() > 4
            || !Path::new(&tool[0]).is_absolute()
            || tool
                .iter()
                .any(|part| part.is_empty() || part.contains('\0') || part.len() > 4096)
        {
            return Err("Invalid simulator tool".into());
        }
        let set = value["deviceSet"].as_str().ok_or("Missing device set")?;
        let expected = dir.join(DEVICE_SET);
        if private_directory(set)? != expected {
            return Err("The device set must be this assignment's own".into());
        }
        let udid = value["udid"].as_str().ok_or("Missing simulator identity")?;
        uuid(&json!({ "id": udid.to_ascii_lowercase() }), "id")?;
        let log = OpenOptions::new()
            .append(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(dir.join("simulator.log"))
            .ok()
            .filter(|file| file.metadata().is_ok_and(|meta| meta.is_file()));
        Ok(Simulator {
            tool,
            set: set.to_owned(),
            udid: udid.to_owned(),
            environment: environment.to_vec(),
            cwd: dir.to_owned(),
            log,
            tree: Tree::new(set),
        })
    }
    /// Runs `simctl --set <set> <verb> <udid>` in its own process group and waits for it,
    /// calling `check` while it waits. A stop reason or the time limit kills that group.
    fn tool(
        &self,
        verb: &str,
        limit: Duration,
        mut check: impl FnMut() -> Option<&'static str>,
    ) -> std::result::Result<i32, &'static str> {
        let mut command = Command::new(&self.tool[0]);
        command
            .args(&self.tool[1..])
            .args(["--set", &self.set, verb, &self.udid])
            .env_clear()
            .envs(self.environment.iter().map(|(k, v)| (k, v)))
            .current_dir(&self.cwd)
            .stdin(Stdio::null())
            .process_group(0);
        let outputs = self
            .log
            .as_ref()
            .and_then(|log| Some((log.try_clone().ok()?, log.try_clone().ok()?)));
        match outputs {
            Some((out, error)) => command.stdout(out).stderr(error),
            None => command.stdout(Stdio::null()).stderr(Stdio::null()),
        };
        let Ok(mut child) = command.spawn() else {
            return Err("tool");
        };
        let deadline = Instant::now() + limit;
        loop {
            if let Ok(Some(status)) = child.try_wait() {
                return Ok(status.code().unwrap_or(-1));
            }
            let reason = check().or_else(|| (Instant::now() >= deadline).then_some("tool"));
            if let Some(reason) = reason {
                // The leader is still our unreaped child, so its group ID cannot be reused.
                unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
                let _ = child.wait();
                return Err(reason);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    /// Nothing may already name this device set before the first boot.
    fn idle(&self) -> bool {
        inventory().is_ok_and(|processes| self.tree.alive(&processes, None).is_empty())
    }
    /// Records the tree's current members. `None` means the inventory was unavailable;
    /// `Err` means the record could not be saved, which ends the lease.
    fn sample(
        &mut self,
        dir: &Path,
        identity: &Value,
        excluded: Option<i32>,
    ) -> std::result::Result<Option<bool>, ()> {
        let Ok(processes) = inventory() else {
            return Ok(None);
        };
        let (present, changed) = self.tree.observe(&processes, excluded);
        if changed {
            let members: Vec<Value> = self
                .tree
                .seen
                .iter()
                .map(|(pid, started)| json!([pid, started]))
                .collect();
            let record = json!({"version": 1, "machineId": identity["machineId"], "leaseId": identity["leaseId"],
                "bootId": identity["bootId"], "members": members, "truncated": self.tree.truncated});
            save(dir, TREE, &record).map_err(|_| ())?;
        }
        Ok(Some(present))
    }
    /// Infallible: it returns only after an inventory shows no member of this device set's
    /// tree. `simctl shutdown` is the graceful path. Members that outlive it are killed after
    /// re-reading their identity (PID and start time) in the same inventory; without a pidfd
    /// that is the narrowest window available. Nothing outside the tree is ever signalled.
    fn stop(&mut self, dir: &Path, identity: &Value) -> TreeStop {
        // A last look while launchd_sim still parents its tree. The supervised child's
        // group is already gone, so nothing is excluded from here on.
        let _ = self.sample(dir, identity, None);
        let shutdown = self.tool("shutdown", SHUTDOWN_LIMIT, || None).ok();
        let since = Instant::now();
        let mut forced = false;
        loop {
            if let Ok(processes) = inventory() {
                let alive = self.tree.alive(&processes, None);
                if alive.is_empty() {
                    break;
                }
                if since.elapsed() >= TREE_GRACE {
                    forced = true;
                    for pid in alive {
                        unsafe { libc::kill(pid, libc::SIGKILL) };
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        TreeStop {
            absent: !self.tree.truncated,
            forced,
            shutdown,
        }
    }
}

/// Whether anything of a leased simulator's device set still runs, for a host whose
/// supervisor is gone. `absent` is the only positive answer: no process names the device
/// set, none descends from one that does, and no recorded member is still alive.
pub fn simulator_status(path: &str, set: &str) -> Result<&'static str> {
    let dir = PathBuf::from(path);
    if !dir.is_absolute() || Path::new(set) != dir.join(DEVICE_SET) {
        return Err("The device set must be this assignment's own".into());
    }
    let mut tree = Tree::new(set);
    if let Some(record) = read_bounded(&dir, TREE)? {
        if record["version"] != 1 {
            return Err("Unsupported tree record".into());
        }
        if record["truncated"] != false {
            return Ok("unknown");
        }
        for member in record["members"].as_array().ok_or("Invalid tree record")? {
            let pid = member[0]
                .as_i64()
                .filter(|pid| *pid > 1 && *pid <= i32::MAX as i64)
                .ok_or("Invalid tree member")?;
            let started = member[1].as_str().ok_or("Invalid tree member")?;
            tree.seen.insert(pid as i32, started.to_owned());
        }
    }
    let processes = inventory()?;
    Ok(if tree.alive(&processes, None).is_empty() {
        "absent"
    } else {
        "present"
    })
}

/// Everything validated before anything is spawned. Holding it holds the lifetime lock.
pub struct Prepared {
    dir: PathBuf,
    identity: Value,
    session: String,
    current: Authorization,
    command: Command,
    log: File,
    started: f64,
    simulator: Option<Simulator>,
    _lock: File,
}

/// Validates one launch request and takes the storage's lifetime lock. Any error here
/// means nothing was spawned; the caller reports it with the dedicated `REFUSED` code.
pub fn prepare(path: &str, request: &Value, elapsed: fn() -> Result<f64>) -> Result<Prepared> {
    let dir = private_directory(path)?;
    if request["version"] != 1 {
        return Err("Unsupported launch request".into());
    }
    let identity = json!({
        "machineId": uuid(request, "machineId")?,
        "leaseId": uuid(request, "leaseId")?,
        "bootId": uuid(request, "bootId")?,
    });
    let lock = lock_file(&dir, true)?;
    // A runner's status probe holds the lock only for an instant; a live supervisor never lets go.
    let deadline = Instant::now() + Duration::from_secs(2);
    while !try_lock(&lock)? {
        if Instant::now() >= deadline {
            return Err("Another supervisor owns this assignment".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    for name in [SUPERVISOR, FENCED, STOPPED, TREE] {
        if std::fs::symlink_metadata(dir.join(name)).is_ok() {
            return Err("A supervised launch already used this assignment".into());
        }
    }
    let executable = request["executable"].as_str().ok_or("Missing executable")?;
    let cwd = request["cwd"].as_str().ok_or("Missing working directory")?;
    if !Path::new(executable).is_absolute() || !Path::new(cwd).is_absolute() {
        return Err("Launch paths must be absolute".into());
    }
    let args = request["args"].as_array().ok_or("Missing args")?;
    let env = request["env"].as_object().ok_or("Missing environment")?;
    if args.len() > 100 || env.len() > 256 {
        return Err("Launch request exceeds its envelope".into());
    }
    let session = boot_session()?;
    let current = authorization(
        &read_bounded(&dir, AUTHORIZATION)?.ok_or("Authorization is missing")?,
        &identity,
        &session,
    )?;
    // The only clock sample before spawn: nothing after spawn may fail early.
    let started = elapsed()?;
    if current.fenced || started >= current.deadline {
        return Err("Authorization has already ended".into());
    }
    let mut command = Command::new(executable);
    for arg in args {
        let arg = arg.as_str().ok_or("Invalid argument")?;
        if arg.contains('\0') || arg.len() > 16384 {
            return Err("Invalid argument".into());
        }
        command.arg(arg);
    }
    command.env_clear();
    let mut environment = Vec::with_capacity(env.len());
    for (key, value) in env {
        let value = value.as_str().ok_or("Invalid environment")?;
        if key.is_empty() || key.contains(['=', '\0']) || value.contains('\0') {
            return Err("Invalid environment".into());
        }
        command.env(key, value);
        environment.push((key.to_owned(), value.to_owned()));
    }
    command
        .current_dir(cwd)
        .stdin(Stdio::null())
        .process_group(0);
    let simulator = match request.get("simulator") {
        Some(value) => Some(Simulator::parse(value, &dir, &environment)?),
        None => None,
    };
    // The supervised child is the emulator, or a leased simulator's control companion.
    let log = OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(dir.join(if simulator.is_some() {
            "companion.log"
        } else {
            "emulator.log"
        }))?;
    if !log.metadata()?.is_file() {
        return Err("Emulator log must be regular".into());
    }
    Ok(Prepared {
        dir,
        identity,
        session,
        current,
        command,
        log,
        started,
        simulator,
        _lock: lock,
    })
}

/// Copies the emulator's output into its log up to `LOG_LIMIT`, then drains and drops it.
fn copy_capped(mut reader: io::PipeReader, mut log: File) {
    let mut written = log.metadata().map(|m| m.len()).unwrap_or(LOG_LIMIT);
    let mut buffer = [0u8; 16384];
    let mut truncated = false;
    loop {
        let count = match reader.read(&mut buffer) {
            Ok(0) => return,
            Ok(count) => count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return,
        };
        if written < LOG_LIMIT {
            let take = count.min((LOG_LIMIT - written) as usize);
            if log.write_all(&buffer[..take]).is_ok() {
                written += take as u64;
            }
        } else if !truncated {
            truncated = true;
            let _ = log.write_all(b"\n[canaveral: emulator log truncated at its size limit]\n");
        }
    }
}

/// Spawns the prepared emulator and owns it until the whole group is gone. Returns the
/// process exit code: `REFUSED` only when nothing was spawned, 0 after a written stop
/// receipt, 1 when the group was stopped but its receipt could not be written. Every
/// path after spawn ends in the infallible group stop.
pub fn run(prepared: Prepared, elapsed: fn() -> Result<f64>, announce: impl FnOnce(&Value)) -> i32 {
    let Prepared {
        dir,
        identity,
        session,
        current,
        mut command,
        log,
        started,
        mut simulator,
        _lock,
    } = prepared;
    if TERMINATE.load(Ordering::SeqCst) {
        return REFUSED;
    }
    // A device set that already has processes was not left by this launch: refuse it.
    if simulator.as_ref().is_some_and(|sim| !sim.idle()) {
        return REFUSED;
    }
    let Ok((reader, writer)) = io::pipe() else {
        return REFUSED;
    };
    let Ok(stderr) = writer.try_clone() else {
        return REFUSED;
    };
    let child = match command.stdout(writer).stderr(stderr).spawn() {
        Ok(child) => child,
        // std reaps a child whose exec failed before returning the error.
        Err(_) => return REFUSED,
    };
    // Drop the parent's pipe writers so the copier ends with the group.
    drop(command);
    // Thread creation can fail after the child exists; a failed copier must not skip the group stop,
    // so it only loses the log (the reader is dropped and the child sees a closed pipe on write).
    let _ = std::thread::Builder::new().spawn(move || copy_capped(reader, log));
    let pid = child.id();
    let mut group = Group {
        child,
        pgid: pid as i32,
    };
    let mut record = json!({
        "version": 1, "machineId": identity["machineId"], "leaseId": identity["leaseId"],
        "bootId": identity["bootId"], "bootSessionID": session,
        "supervisorPid": std::process::id(), "childPid": pid, "startedAt": started,
    });
    if let Some(sim) = &simulator {
        record["simulator"] = json!({"deviceSet": sim.set, "udid": sim.udid});
    }
    let mut state = Watch {
        dir: &dir,
        identity: &identity,
        session: &session,
        current,
        elapsed,
    };
    let reason = match save(&dir, SUPERVISOR, &record) {
        Ok(()) => {
            announce(&json!({"supervisorPid": std::process::id(), "childPid": pid}));
            // The simulator boots only after the record exists, so a host that lost this
            // process always finds the device set it has to prove stopped.
            let booted = match &simulator {
                Some(sim) => match sim.tool("boot", BOOT_LIMIT, || state.check(&group)) {
                    Ok(0) => None,
                    Ok(_) | Err("tool") => Some("boot"),
                    Err(reason) => Some(reason),
                },
                None => None,
            };
            booted.unwrap_or_else(|| watch(&mut state, &group, simulator.as_mut()))
        }
        Err(_) => "record",
    };
    // An emulator that exited on its own needs no fence. A simulator is still shut down
    // below, which takes time, so its fence is always published first.
    if reason != "exited" || simulator.is_some() {
        // A failed sticky marker must never prevent stopping the group.
        let _ = save(
            &dir,
            FENCED,
            &json!({"version": 1, "machineId": identity["machineId"], "leaseId": identity["leaseId"],
                "bootId": identity["bootId"], "reason": reason}),
        );
    }
    let status = group.stop(Duration::from_secs(5));
    let mut receipt = json!({"version": 1, "machineId": identity["machineId"], "leaseId": identity["leaseId"],
        "bootId": identity["bootId"], "bootSessionID": session, "reason": reason,
        "supervisorPid": std::process::id(), "childPid": pid, "groupAbsent": true, "exitStatus": status});
    if let Some(sim) = simulator.as_mut() {
        // Never exits while a member of the device set's tree may survive.
        let stopped = sim.stop(&dir, &identity);
        receipt["simulator"] = json!({"deviceSet": sim.set, "udid": sim.udid});
        receipt["treeAbsent"] = json!(stopped.absent);
        receipt["treeForced"] = json!(stopped.forced);
        receipt["shutdownStatus"] = json!(stopped.shutdown);
    }
    // The lifetime lock is released only after the receipt, when `_lock` drops.
    if save(&dir, STOPPED, &receipt).is_ok() {
        0
    } else {
        1
    }
}

/// `lease-supervise <dir>` with one JSON launch request on stdin. Returns the exit code.
pub fn supervise(path: &str, elapsed: fn() -> Result<f64>) -> i32 {
    let read = || -> Result<Value> {
        let mut line = Vec::new();
        io::stdin()
            .lock()
            .take(1_048_577)
            .read_until(b'\n', &mut line)?;
        if line.len() > 1_048_576 || line.last() != Some(&b'\n') {
            return Err("Launch request exceeds its envelope".into());
        }
        Ok(serde_json::from_slice(&line)?)
    };
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
        libc::signal(libc::SIGHUP, libc::SIG_IGN);
        libc::signal(libc::SIGTERM, terminate as *const () as libc::sighandler_t);
        libc::signal(libc::SIGINT, terminate as *const () as libc::sighandler_t);
    }
    let prepared = match read().and_then(|request| prepare(path, &request, elapsed)) {
        Ok(prepared) => prepared,
        Err(_) => return REFUSED,
    };
    run(prepared, elapsed, |line| {
        // The host reads this one line; afterwards nothing is written to its pipe.
        let mut out = io::stdout().lock();
        let _ = writeln!(out, "{line}");
        let _ = out.flush();
        drop(out);
        if let Ok(null) = CString::new("/dev/null") {
            let fd = unsafe { libc::open(null.as_ptr(), libc::O_RDWR) };
            if fd >= 0 {
                unsafe {
                    libc::dup2(fd, 0);
                    libc::dup2(fd, 1);
                    libc::dup2(fd, 2);
                    libc::close(fd);
                }
            }
        }
    })
}

/// The authorization this process enforces, re-read on every supervision tick.
struct Watch<'a> {
    dir: &'a Path,
    identity: &'a Value,
    session: &'a str,
    current: Authorization,
    elapsed: fn() -> Result<f64>,
}

impl Watch<'_> {
    /// One tick: the reason to stop now, if any.
    fn check(&mut self, group: &Group) -> Option<&'static str> {
        match group.exited() {
            Ok(true) => return Some("exited"),
            Ok(false) => {}
            Err(_) => return Some("process"),
        }
        if TERMINATE.load(Ordering::SeqCst) {
            return Some("signal");
        }
        let Ok(now) = (self.elapsed)() else {
            return Some("clock");
        };
        let next = match read_bounded(self.dir, AUTHORIZATION) {
            Ok(Some(value)) => match authorization(&value, self.identity, self.session) {
                Ok(next) => next,
                Err(_) => return Some("authorization"),
            },
            _ => return Some("authorization"),
        };
        self.current = advance(&self.current, &next, now);
        if self.current.fenced {
            return Some("fenced");
        }
        if now >= self.current.deadline {
            return Some("expired");
        }
        None
    }
}

fn watch(state: &mut Watch, group: &Group, mut simulator: Option<&mut Simulator>) -> &'static str {
    let (booted, mut ticks, mut seen) = (Instant::now(), 0u32, false);
    loop {
        std::thread::sleep(Duration::from_millis(100));
        if let Some(reason) = state.check(group) {
            return reason;
        }
        let Some(sim) = simulator.as_deref_mut() else {
            continue;
        };
        // Sampling the tree needs a process inventory, so it runs less often than the
        // deadline check. The deadline never waits for it.
        ticks = ticks.wrapping_add(1);
        if ticks % SAMPLE_TICKS != 1 {
            continue;
        }
        match sim.sample(state.dir, state.identity, Some(group.pgid)) {
            Ok(Some(true)) => seen = true,
            // The simulator stopped by itself, or never appeared after its boot.
            Ok(Some(false)) if seen || booted.elapsed() >= START_WINDOW => return "exited",
            Ok(_) => {}
            Err(()) => return "record",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    fn auth(revision: u64, deadline: f64, fenced: bool) -> Authorization {
        Authorization {
            revision,
            deadline,
            fenced,
        }
    }
    #[test]
    fn renewal_needs_a_newer_revision_before_expiry() {
        let current = auth(2, 100.0, false);
        assert_eq!(
            advance(&current, &auth(3, 200.0, false), 50.0).deadline,
            200.0
        );
        assert_eq!(
            advance(&current, &auth(2, 200.0, false), 50.0).deadline,
            100.0
        );
        assert_eq!(
            advance(&current, &auth(2, 80.0, false), 50.0).deadline,
            80.0
        );
        assert_eq!(
            advance(&current, &auth(1, 300.0, false), 50.0).deadline,
            100.0
        );
        assert_eq!(
            advance(&current, &auth(3, 300.0, false), 100.0).deadline,
            100.0
        );
        assert!(advance(&current, &auth(1, 300.0, true), 50.0).fenced);
        assert!(advance(&auth(2, 100.0, true), &auth(3, 300.0, false), 50.0).fenced);
    }
    #[test]
    fn authorization_binds_assignment_and_boot() {
        let identity = json!({"machineId": "11111111-1111-4111-8111-111111111111", "leaseId": "22222222-2222-4222-8222-222222222222", "bootId": "33333333-3333-4333-8333-333333333333"});
        let session = "44444444-4444-4444-8444-444444444444";
        let mut value = identity.clone();
        value["version"] = json!(1);
        value["bootSessionID"] = json!(session);
        value["revision"] = json!(1);
        value["deadline"] = json!(10.5);
        value["fenced"] = json!(false);
        assert_eq!(
            authorization(&value, &identity, session).unwrap(),
            auth(1, 10.5, false)
        );
        assert!(authorization(&value, &identity, "55555555-5555-4555-8555-555555555555").is_err());
        let mut other = value.clone();
        other["leaseId"] = json!("66666666-6666-4666-8666-666666666666");
        assert!(authorization(&other, &identity, session).is_err());
        other = value.clone();
        other["deadline"] = json!(-1.0);
        assert!(authorization(&other, &identity, session).is_err());
    }
    #[test]
    fn boot_session_is_a_uuid() {
        assert_eq!(boot_session().unwrap().len(), 36);
    }

    // Test clocks: a fixed origin, and one that fails on every call after the first.
    fn clock() -> Result<f64> {
        Ok(1000.0)
    }
    static FAILING_CALLS: AtomicUsize = AtomicUsize::new(0);
    fn failing_clock() -> Result<f64> {
        if FAILING_CALLS.fetch_add(1, Ordering::SeqCst) == 0 {
            Ok(1000.0)
        } else {
            Err("clock lost".into())
        }
    }
    fn storage(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lease-supervisor-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::os::unix::fs::PermissionsExt::from_mode(0o700))
            .unwrap();
        std::fs::canonicalize(dir).unwrap()
    }
    fn request(dir: &Path, deadline: f64, fenced: bool) -> Value {
        let identity = json!({"machineId": "11111111-1111-4111-8111-111111111111", "leaseId": "22222222-2222-4222-8222-222222222222", "bootId": "33333333-3333-4333-8333-333333333333"});
        let mut value = identity.clone();
        value["version"] = json!(1);
        value["bootSessionID"] = json!(boot_session().unwrap());
        value["revision"] = json!(1);
        value["deadline"] = json!(deadline);
        value["fenced"] = json!(fenced);
        save(dir, AUTHORIZATION, &value).unwrap();
        let mut launch = identity;
        launch["version"] = json!(1);
        launch["executable"] = json!("/bin/sh");
        launch["args"] = json!(["-c", "sleep 30 & sleep 30"]);
        launch["env"] = json!({});
        launch["cwd"] = json!(dir.to_str().unwrap());
        launch
    }
    fn group_alive(pgid: i32) -> bool {
        unsafe { libc::kill(-pgid, 0) == 0 }
    }

    #[test]
    fn a_clock_failure_after_spawn_still_stops_the_whole_group() {
        let dir = storage("clock");
        let launch = request(&dir, 5000.0, false);
        let prepared = prepare(dir.to_str().unwrap(), &launch, failing_clock).unwrap();
        let mut spawned = None;
        let code = run(prepared, failing_clock, |line| {
            spawned = line["childPid"].as_i64();
        });
        let pid = spawned.expect("the emulator was spawned") as i32;
        assert_eq!(code, 0);
        assert!(!group_alive(pid));
        let stopped = read_bounded(&dir, STOPPED).unwrap().unwrap();
        assert_eq!(stopped["reason"], "clock");
        assert_eq!(stopped["groupAbsent"], true);
        assert_eq!(
            read_bounded(&dir, FENCED).unwrap().unwrap()["reason"],
            "clock"
        );
        assert_eq!(status(dir.to_str().unwrap()).unwrap(), "free");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn ended_authorization_is_refused_before_anything_spawns() {
        let dir = storage("refused");
        for (deadline, fenced) in [(999.0, false), (5000.0, true)] {
            let launch = request(&dir, deadline, fenced);
            assert!(prepare(dir.to_str().unwrap(), &launch, clock).is_err());
            assert!(!dir.join(SUPERVISOR).exists());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_lifetime_lock_is_held_until_the_stop_receipt_and_excludes_a_second_supervisor() {
        let dir = storage("lock");
        let path = dir.to_str().unwrap().to_owned();
        assert_eq!(status(&path).unwrap(), "absent");
        let launch = request(&dir, 5000.0, false);
        let prepared = prepare(&path, &launch, clock).unwrap();
        assert_eq!(status(&path).unwrap(), "held");
        let worker = std::thread::spawn(move || run(prepared, clock, |_| {}));
        while !dir.join(SUPERVISOR).exists() {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(status(&path).unwrap(), "held");
        // A second supervisor for the same storage is refused while the first lives.
        assert!(prepare(&path, &launch, clock).is_err());
        request(&dir, 5000.0, true);
        assert_eq!(worker.join().unwrap(), 0);
        assert!(dir.join(STOPPED).exists());
        assert_eq!(status(&path).unwrap(), "free");
        // Even with the lock free, a used assignment is never launched again.
        request(&dir, 5000.0, false);
        assert!(prepare(&path, &launch, clock).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    // A stand-in `simctl`. `boot` leaves an orphaned root whose command line names the
    // device set, with one child that names nothing: the shape of a booted simulator's
    // `launchd_sim` and a runtime daemon. Neither is a child of the supervisor.
    const UDID: &str = "5A0E2F31-5B7C-4D8E-9F01-23456789ABCD";
    const GRACEFUL: &str = r#"pid=$(cat "$set/$udid.pid"); kill -TERM "$pid" 2>/dev/null; while kill -0 "$pid" 2>/dev/null; do sleep 0.1; done"#;
    fn simulated(name: &str, shutdown: &str) -> (PathBuf, Value) {
        let dir = storage(name);
        let set = dir.join(DEVICE_SET);
        std::fs::create_dir_all(set.join(UDID).join("data")).unwrap();
        std::fs::set_permissions(&set, std::os::unix::fs::PermissionsExt::from_mode(0o700))
            .unwrap();
        let tool = dir.join("simctl");
        let script = format!(
            r#"#!/bin/sh
set="$2"; verb="$3"; udid="$4"
case "$verb" in
  boot)
    /bin/sh -c 'trap "kill \$child; exit 0" TERM; sleep 300 & child=$!; echo $child > "$0.child"; wait' "$set/$udid/data/launchd_bootstrap.plist" >/dev/null 2>&1 &
    echo $! > "$set/$udid.pid" ;;
  shutdown) {shutdown} ;;
  *) exit 2 ;;
esac
"#
        );
        std::fs::write(&tool, script).unwrap();
        std::fs::set_permissions(&tool, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        let mut launch = request(&dir, 5000.0, false);
        launch["simulator"] = json!({"tool": [tool.to_str().unwrap()], "deviceSet": set.to_str().unwrap(), "udid": UDID});
        (dir, launch)
    }
    fn number(path: PathBuf) -> i32 {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(text) = std::fs::read_to_string(&path) {
                if let Ok(value) = text.trim().parse() {
                    return value;
                }
            }
            assert!(Instant::now() < deadline, "missing {path:?}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    fn process_alive(pid: i32) -> bool {
        inventory()
            .unwrap()
            .iter()
            .any(|p| p.pid == pid && !p.zombie)
    }
    /// Boots under the real supervisor loop and returns the stand-in root and its child.
    fn booted(
        dir: &Path,
        launch: &Value,
        announced: std::sync::mpsc::Sender<i64>,
    ) -> (std::thread::JoinHandle<i32>, i32, i32) {
        let prepared = prepare(dir.to_str().unwrap(), launch, clock).unwrap();
        let worker = std::thread::spawn(move || {
            run(prepared, clock, |line| {
                let _ = announced.send(line["childPid"].as_i64().unwrap());
            })
        });
        let set = dir.join(DEVICE_SET);
        let root = number(set.join(format!("{UDID}.pid")));
        let child = number(
            set.join(UDID)
                .join("data")
                .join("launchd_bootstrap.plist.child"),
        );
        // The first sample records both members while the root still parents its child.
        let deadline = Instant::now() + Duration::from_secs(10);
        while !read_bounded(dir, TREE).is_ok_and(|tree| {
            tree.is_some_and(|tree| tree["members"].as_array().is_some_and(|m| m.len() == 2))
        }) {
            assert!(Instant::now() < deadline, "the tree was never recorded");
            std::thread::sleep(Duration::from_millis(20));
        }
        (worker, root, child)
    }

    #[test]
    fn a_leased_simulator_is_booted_then_shut_down_and_its_tree_proven_gone() {
        let (dir, launch) = simulated("simulator", GRACEFUL);
        let path = dir.to_str().unwrap().to_owned();
        let set = dir.join(DEVICE_SET).to_str().unwrap().to_owned();
        assert_eq!(simulator_status(&path, &set).unwrap(), "absent");
        let (sender, receiver) = std::sync::mpsc::channel();
        let (worker, root, child) = booted(&dir, &launch, sender);
        let companion = receiver.recv().unwrap() as i32;
        assert!(process_alive(root) && process_alive(child) && group_alive(companion));
        let record = read_bounded(&dir, SUPERVISOR).unwrap().unwrap();
        assert_eq!(record["simulator"]["udid"], UDID);
        assert_eq!(record["childPid"], companion);
        assert_eq!(simulator_status(&path, &set).unwrap(), "present");
        assert_eq!(status(&path).unwrap(), "held");
        // The fence: the companion's group and the simulator's tree both stop.
        request(&dir, 5000.0, true);
        assert_eq!(worker.join().unwrap(), 0);
        let stopped = read_bounded(&dir, STOPPED).unwrap().unwrap();
        assert_eq!(stopped["reason"], "fenced");
        assert_eq!(stopped["groupAbsent"], true);
        assert_eq!(stopped["treeAbsent"], true);
        assert_eq!(stopped["treeForced"], false);
        assert_eq!(stopped["shutdownStatus"], 0);
        assert_eq!(stopped["simulator"]["deviceSet"], set.as_str());
        assert!(!process_alive(root) && !process_alive(child) && !group_alive(companion));
        assert_eq!(status(&path).unwrap(), "free");
        assert_eq!(simulator_status(&path, &set).unwrap(), "absent");
        // A used assignment is never booted again.
        request(&dir, 5000.0, false);
        assert!(prepare(&path, &launch, clock).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_tree_member_that_outlives_the_simulator_is_still_found_and_stopped() {
        // The shutdown kills only the root: its child is reparented and names nothing.
        let (dir, launch) = simulated("orphan", r#"kill -KILL "$(cat "$set/$udid.pid")""#);
        let (sender, _receiver) = std::sync::mpsc::channel();
        let (worker, root, child) = booted(&dir, &launch, sender);
        request(&dir, 5000.0, true);
        assert_eq!(worker.join().unwrap(), 0);
        let stopped = read_bounded(&dir, STOPPED).unwrap().unwrap();
        assert_eq!(stopped["treeAbsent"], true);
        assert_eq!(stopped["treeForced"], true);
        assert!(!process_alive(root) && !process_alive(child));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_failed_shutdown_command_never_leaves_the_tree_running() {
        let (dir, launch) = simulated("stuck", "exit 1");
        let (sender, _receiver) = std::sync::mpsc::channel();
        let (worker, root, child) = booted(&dir, &launch, sender);
        request(&dir, 5000.0, true);
        assert_eq!(worker.join().unwrap(), 0);
        let stopped = read_bounded(&dir, STOPPED).unwrap().unwrap();
        assert_eq!(stopped["shutdownStatus"], 1);
        assert_eq!(stopped["treeForced"], true);
        assert_eq!(stopped["treeAbsent"], true);
        assert!(!process_alive(root) && !process_alive(child));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_simulator_that_stops_by_itself_ends_the_lease_with_a_receipt() {
        let (dir, launch) = simulated("gone", GRACEFUL);
        let (sender, receiver) = std::sync::mpsc::channel();
        let (worker, root, _child) = booted(&dir, &launch, sender);
        let companion = receiver.recv().unwrap() as i32;
        unsafe { libc::kill(root, libc::SIGTERM) };
        assert_eq!(worker.join().unwrap(), 0);
        let stopped = read_bounded(&dir, STOPPED).unwrap().unwrap();
        assert_eq!(stopped["reason"], "exited");
        assert_eq!(stopped["treeAbsent"], true);
        // Access ends while the shutdown is still being proven.
        assert_eq!(
            read_bounded(&dir, FENCED).unwrap().unwrap()["reason"],
            "exited"
        );
        assert!(!group_alive(companion));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_failed_boot_still_ends_in_the_stop_and_its_receipt() {
        let (dir, mut launch) = simulated("boot", GRACEFUL);
        // `false` ignores its arguments and fails: nothing boots.
        launch["simulator"]["tool"] = json!(["/usr/bin/false"]);
        let path = dir.to_str().unwrap().to_owned();
        let prepared = prepare(&path, &launch, clock).unwrap();
        let mut spawned = None;
        assert_eq!(
            run(prepared, clock, |line| spawned = line["childPid"].as_i64()),
            0
        );
        let stopped = read_bounded(&dir, STOPPED).unwrap().unwrap();
        assert_eq!(stopped["reason"], "boot");
        assert_eq!(stopped["treeAbsent"], true);
        assert!(!group_alive(
            spawned.expect("the companion was spawned") as i32
        ));
        assert_eq!(status(&path).unwrap(), "free");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_foreign_or_occupied_device_set_is_refused_before_anything_spawns() {
        let (dir, launch) = simulated("refuse", GRACEFUL);
        let path = dir.to_str().unwrap().to_owned();
        // Another directory, however private, is not this assignment's device set.
        let other = dir.join("other-set");
        std::fs::create_dir(&other).unwrap();
        std::fs::set_permissions(&other, std::os::unix::fs::PermissionsExt::from_mode(0o700))
            .unwrap();
        for (key, value) in [
            ("deviceSet", json!(other.to_str().unwrap())),
            ("deviceSet", json!(std::env::temp_dir().to_str().unwrap())),
            ("udid", json!("not-a-device")),
            ("tool", json!(["simctl"])),
            ("tool", json!([])),
        ] {
            let mut changed = launch.clone();
            changed["simulator"][key] = value;
            assert!(prepare(&path, &changed, clock).is_err(), "{key}");
        }
        // A device set that already has a process was not left by this launch.
        let set = dir.join(DEVICE_SET);
        // It waits on its own input, so it has no child and keeps its command line.
        let mut occupant = Command::new("/bin/sh")
            .args([
                "-c",
                "read line; :",
                set.join(UDID).join("data").to_str().unwrap(),
            ])
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while simulator_status(&path, set.to_str().unwrap()).unwrap() != "present" {
            assert!(Instant::now() < deadline, "the occupant never appeared");
            std::thread::sleep(Duration::from_millis(20));
        }
        let prepared = prepare(&path, &launch, clock).unwrap();
        assert_eq!(run(prepared, clock, |_| {}), REFUSED);
        assert!(!dir.join(SUPERVISOR).exists() && !dir.join(STOPPED).exists());
        assert_eq!(
            simulator_status(&path, set.to_str().unwrap()).unwrap(),
            "present"
        );
        occupant.kill().unwrap();
        occupant.wait().unwrap();
        assert_eq!(
            simulator_status(&path, set.to_str().unwrap()).unwrap(),
            "absent"
        );
        assert!(simulator_status(&path, other.to_str().unwrap()).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_lost_supervisors_recorded_members_keep_the_tree_present_until_they_are_gone() {
        let (dir, _launch) = simulated("lost", GRACEFUL);
        let path = dir.to_str().unwrap().to_owned();
        let set = dir.join(DEVICE_SET).to_str().unwrap().to_owned();
        // A member that names nothing: only the record left by the supervisor finds it.
        let mut member = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let pid = member.id() as i32;
        let started = inventory()
            .unwrap()
            .into_iter()
            .find(|p| p.pid == pid)
            .unwrap()
            .started;
        let record = |members: Value, truncated: bool| {
            save(
                &dir,
                TREE,
                &json!({"version": 1, "members": members, "truncated": truncated}),
            )
            .unwrap()
        };
        record(json!([[pid, started]]), false);
        assert_eq!(simulator_status(&path, &set).unwrap(), "present");
        // The same PID with another start time is another process.
        record(json!([[pid, "Thu Jan 1 00:00:00 1970"]]), false);
        assert_eq!(simulator_status(&path, &set).unwrap(), "absent");
        // A record that lost members can never prove absence.
        record(json!([]), true);
        assert_eq!(simulator_status(&path, &set).unwrap(), "unknown");
        record(json!([[pid, started]]), false);
        member.kill().unwrap();
        member.wait().unwrap();
        assert_eq!(simulator_status(&path, &set).unwrap(), "absent");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_emulator_log_is_capped() {
        let dir = storage("log");
        let path = dir.join("emulator.log");
        let log = OpenOptions::new()
            .append(true)
            .create(true)
            .open(&path)
            .unwrap();
        let (reader, mut writer) = io::pipe().unwrap();
        let copier = std::thread::spawn(move || copy_capped(reader, log));
        let chunk = vec![b'x'; 1 << 20];
        for _ in 0..(LOG_LIMIT >> 20) + 2 {
            writer.write_all(&chunk).unwrap();
        }
        drop(writer);
        copier.join().unwrap();
        let size = std::fs::metadata(&path).unwrap().len();
        assert!(size > LOG_LIMIT && size < LOG_LIMIT + 4096, "{size}");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
