//! Independent deadline owner for one supervised Android emulator.
//!
//! The host publishes `lease-authorization.json` with an absolute deadline on this
//! boot's continuous clock. This process owns the emulator's dedicated process
//! group and stops it when that deadline passes, the authorization is fenced,
//! missing or changed, or this process is asked to terminate. It keeps running
//! when the host runner or controller is lost. Only a confirmed absent process
//! group produces `lease-stopped.json`; nothing else is a stop proof.
//!
//! The owner of a launch is either a lease (`leaseId`) or a warm hold (`warmId`).
//! A warm hold is a pre-booted device that belongs to no lease: it has its own
//! fixed deadline and is never renewed. Exactly once, a warm hold may be adopted
//! by a lease: the host replaces the authorization with the lease's identity and
//! deadline, naming the hold in `adoptedFrom`. The supervisor accepts that only
//! while the hold is unfenced and unexpired, records the new owner durably and
//! from then on enforces the lease. Every other owner change is a fence.
//!
//! The supervisor holds an exclusive `flock` on `lease-supervisor.lock` for its whole
//! life, so the host can prove it is gone without trusting a PID. It exits with
//! `REFUSED` only when it spawned nothing; every path after spawn stops the group first.
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

/// Who a supervised launch belongs to. A warm hold is not a lease.
#[derive(Clone, Debug, PartialEq)]
pub enum Owner {
    Lease(String),
    Warm(String),
}
impl Owner {
    /// Exactly one of `leaseId` and `warmId` names the owner.
    fn parse(value: &Value) -> Result<Owner> {
        match (value.get("leaseId"), value.get("warmId")) {
            (Some(_), None) => Ok(Owner::Lease(uuid(value, "leaseId")?)),
            (None, Some(_)) => Ok(Owner::Warm(uuid(value, "warmId")?)),
            _ => Err("Expected exactly one owner identity".into()),
        }
    }
    fn key(&self) -> &'static str {
        match self {
            Owner::Lease(_) => "leaseId",
            Owner::Warm(_) => "warmId",
        }
    }
    fn id(&self) -> &str {
        match self {
            Owner::Lease(id) | Owner::Warm(id) => id,
        }
    }
}

/// The assignment, launch and current owner a supervisor enforces.
#[derive(Clone, Debug, PartialEq)]
pub struct Identity {
    pub machine: String,
    pub boot: String,
    pub owner: Owner,
    /// The warm hold this lease adopted, once adoption is recorded.
    pub adopted_from: Option<String>,
}
impl Identity {
    fn parse(value: &Value) -> Result<Identity> {
        Ok(Identity {
            machine: uuid(value, "machineId")?,
            boot: uuid(value, "bootId")?,
            owner: Owner::parse(value)?,
            adopted_from: None,
        })
    }
    /// Identity fields shared by every record this supervisor writes.
    fn record(&self) -> Value {
        let mut value = json!({"version": 1, "machineId": self.machine, "bootId": self.boot});
        value[self.owner.key()] = json!(self.owner.id());
        if let Some(hold) = &self.adopted_from {
            value["adoptedFrom"] = json!(hold);
        }
        value
    }
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

/// One published authorization: its owner, an optional adoption claim and its terms.
#[derive(Clone, Debug, PartialEq)]
pub struct Published {
    pub owner: Owner,
    /// Present only on a lease's authorization that claims a warm hold.
    pub adopted_from: Option<String>,
    pub terms: Authorization,
}

/// Reads an authorization for this machine, launch and boot. The caller decides whether
/// its owner is the current one, a valid adoption, or a fence.
pub fn published(value: &Value, identity: &Identity, session: &str) -> Result<Published> {
    if value["version"] != 1 {
        return Err("Unsupported authorization".into());
    }
    if uuid(value, "machineId")? != identity.machine || uuid(value, "bootId")? != identity.boot {
        return Err("Authorization belongs to another assignment".into());
    }
    if uuid(value, "bootSessionID")? != session {
        return Err("Authorization belongs to another boot".into());
    }
    let owner = Owner::parse(value)?;
    let adopted_from = match value.get("adoptedFrom") {
        None => None,
        Some(_) => Some(uuid(value, "adoptedFrom")?),
    };
    Ok(Published {
        owner,
        adopted_from,
        terms: terms(value)?,
    })
}

/// The current owner's authorization; any mismatch is a fence, never a pause.
pub fn authorization(value: &Value, identity: &Identity, session: &str) -> Result<Authorization> {
    let next = published(value, identity, session)?;
    if next.owner != identity.owner {
        return Err("Authorization belongs to another owner".into());
    }
    Ok(next.terms)
}

fn terms(value: &Value) -> Result<Authorization> {
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

/// Whether a warm hold may pass to the lease named by `next`. The hold must still be
/// current (unfenced and unexpired) and the lease's own terms must be current too, so a
/// device is never handed over at or after either deadline. Only a warm hold is adopted,
/// only by a lease that names exactly this hold, and therefore at most once.
pub fn adoptable(identity: &Identity, current: &Authorization, next: &Published, now: f64) -> bool {
    let Owner::Warm(hold) = &identity.owner else {
        return false;
    };
    matches!(next.owner, Owner::Lease(_))
        && next.adopted_from.as_deref() == Some(hold.as_str())
        && !current.fenced
        && now < current.deadline
        && !next.terms.fenced
        && now < next.terms.deadline
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

/// A warm hold is never renewed: whatever is published for it, its deadline only ever
/// shortens and a fence is sticky. No revision extends a hold, so the lifetime a lost
/// runner depends on cannot be lengthened by anything written after the launch.
pub fn hold(current: &Authorization, next: &Authorization) -> Authorization {
    Authorization {
        revision: current.revision,
        deadline: current.deadline.min(next.deadline),
        fenced: current.fenced || next.fenced,
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

/// Everything validated before anything is spawned. Holding it holds the lifetime lock.
pub struct Prepared {
    dir: PathBuf,
    identity: Identity,
    session: String,
    current: Authorization,
    command: Command,
    log: File,
    started: f64,
    _lock: File,
}

/// Validates one launch request and takes the storage's lifetime lock. Any error here
/// means nothing was spawned; the caller reports it with the dedicated `REFUSED` code.
pub fn prepare(path: &str, request: &Value, elapsed: fn() -> Result<f64>) -> Result<Prepared> {
    let dir = private_directory(path)?;
    if request["version"] != 1 {
        return Err("Unsupported launch request".into());
    }
    let identity = Identity::parse(request)?;
    let lock = lock_file(&dir, true)?;
    // A runner's status probe holds the lock only for an instant; a live supervisor never lets go.
    let deadline = Instant::now() + Duration::from_secs(2);
    while !try_lock(&lock)? {
        if Instant::now() >= deadline {
            return Err("Another supervisor owns this assignment".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    for name in [SUPERVISOR, FENCED, STOPPED] {
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
    for (key, value) in env {
        let value = value.as_str().ok_or("Invalid environment")?;
        if key.is_empty() || key.contains(['=', '\0']) || value.contains('\0') {
            return Err("Invalid environment".into());
        }
        command.env(key, value);
    }
    command
        .current_dir(cwd)
        .stdin(Stdio::null())
        .process_group(0);
    let log = OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(dir.join("emulator.log"))?;
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
        mut identity,
        session,
        mut current,
        mut command,
        log,
        started,
        _lock,
    } = prepared;
    if TERMINATE.load(Ordering::SeqCst) {
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
    let launch = Launch {
        session: &session,
        pid,
        started,
    };
    let reason = match save(&dir, SUPERVISOR, &launch.record(&identity)) {
        Ok(()) => {
            announce(&json!({"supervisorPid": std::process::id(), "childPid": pid}));
            watch(&dir, &mut identity, &launch, &mut current, &group, elapsed)
        }
        Err(_) => "record",
    };
    if reason != "exited" {
        // A failed sticky marker must never prevent stopping the group.
        let mut fence = identity.record();
        fence["reason"] = json!(reason);
        let _ = save(&dir, FENCED, &fence);
    }
    let status = group.stop(Duration::from_secs(5));
    // The receipt names the owner at the stop: the lease after an adoption, the hold before it.
    let mut receipt = launch.record(&identity);
    receipt["reason"] = json!(reason);
    receipt["groupAbsent"] = json!(true);
    receipt["exitStatus"] = json!(status);
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

/// The launch facts that never change, for the supervisor record and the stop receipt.
struct Launch<'a> {
    session: &'a str,
    pid: u32,
    started: f64,
}
impl Launch<'_> {
    fn record(&self, identity: &Identity) -> Value {
        let mut value = identity.record();
        value["bootSessionID"] = json!(self.session);
        value["supervisorPid"] = json!(std::process::id());
        value["childPid"] = json!(self.pid);
        value["startedAt"] = json!(self.started);
        value
    }
}

fn watch(
    dir: &Path,
    identity: &mut Identity,
    launch: &Launch,
    current: &mut Authorization,
    group: &Group,
    elapsed: fn() -> Result<f64>,
) -> &'static str {
    let session = launch.session;
    loop {
        std::thread::sleep(Duration::from_millis(100));
        match group.exited() {
            Ok(true) => return "exited",
            Ok(false) => {}
            Err(_) => return "process",
        }
        if TERMINATE.load(Ordering::SeqCst) {
            return "signal";
        }
        let Ok(now) = elapsed() else { return "clock" };
        let next = match read_bounded(dir, AUTHORIZATION) {
            Ok(Some(value)) => match published(&value, identity, session) {
                Ok(next) => next,
                Err(_) => return "authorization",
            },
            _ => return "authorization",
        };
        if next.owner != identity.owner {
            // The only accepted owner change: a lease adopting this still-current warm hold.
            if !adoptable(identity, current, &next, now) {
                return "authorization";
            }
            let Owner::Warm(hold) = identity.owner.clone() else {
                return "authorization";
            };
            let adopted = Identity {
                owner: next.owner.clone(),
                adopted_from: Some(hold),
                ..identity.clone()
            };
            // The durable record is the adoption's commit point and the host's only proof of
            // it. If it cannot be written the device is stopped, never handed to the lease.
            if save(dir, SUPERVISOR, &launch.record(&adopted)).is_err() {
                return "record";
            }
            *identity = adopted;
            *current = next.terms;
            continue;
        }
        *current = match identity.owner {
            Owner::Lease(_) => advance(current, &next.terms, now),
            Owner::Warm(_) => hold(current, &next.terms),
        };
        if current.fenced {
            return "fenced";
        }
        if now >= current.deadline {
            return "expired";
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::OnceLock;
    const MACHINE: &str = "11111111-1111-4111-8111-111111111111";
    const LEASE: &str = "22222222-2222-4222-8222-222222222222";
    const BOOT: &str = "33333333-3333-4333-8333-333333333333";
    const HOLD: &str = "77777777-7777-4777-8777-777777777777";
    fn auth(revision: u64, deadline: f64, fenced: bool) -> Authorization {
        Authorization {
            revision,
            deadline,
            fenced,
        }
    }
    fn identity(owner: Owner) -> Identity {
        Identity {
            machine: MACHINE.into(),
            boot: BOOT.into(),
            owner,
            adopted_from: None,
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
    fn a_warm_hold_is_never_extended_by_any_revision() {
        let current = auth(1, 100.0, false);
        // A lease would accept this renewal; a hold does not.
        assert_eq!(
            advance(&current, &auth(2, 500.0, false), 50.0).deadline,
            500.0
        );
        assert_eq!(
            hold(&current, &auth(2, 500.0, false)),
            auth(1, 100.0, false)
        );
        assert_eq!(hold(&current, &auth(1, 500.0, false)).deadline, 100.0);
        // It can only be shortened or fenced, and a fence stays.
        assert_eq!(hold(&current, &auth(9, 40.0, false)).deadline, 40.0);
        assert!(hold(&current, &auth(1, 100.0, true)).fenced);
        assert!(hold(&auth(1, 100.0, true), &auth(2, 500.0, false)).fenced);
    }
    #[test]
    fn authorization_binds_assignment_owner_and_boot() {
        let owner = identity(Owner::Lease(LEASE.into()));
        let session = "44444444-4444-4444-8444-444444444444";
        let value = json!({"version": 1, "machineId": MACHINE, "leaseId": LEASE, "bootId": BOOT,
            "bootSessionID": session, "revision": 1, "deadline": 10.5, "fenced": false});
        assert_eq!(
            authorization(&value, &owner, session).unwrap(),
            auth(1, 10.5, false)
        );
        assert!(authorization(&value, &owner, "55555555-5555-4555-8555-555555555555").is_err());
        let mut other = value.clone();
        other["leaseId"] = json!("66666666-6666-4666-8666-666666666666");
        assert!(authorization(&other, &owner, session).is_err());
        other = value.clone();
        other["deadline"] = json!(-1.0);
        assert!(authorization(&other, &owner, session).is_err());
        // A warm hold is not a lease: neither owner accepts the other's authorization, and a
        // record that names both, or neither, is refused outright.
        let mut warm = value.clone();
        warm.as_object_mut().unwrap().remove("leaseId");
        warm["warmId"] = json!(HOLD);
        assert!(authorization(&warm, &owner, session).is_err());
        let hold = identity(Owner::Warm(HOLD.into()));
        assert_eq!(
            authorization(&warm, &hold, session).unwrap(),
            auth(1, 10.5, false)
        );
        assert!(authorization(&value, &hold, session).is_err());
        let mut both = value.clone();
        both["warmId"] = json!(HOLD);
        assert!(published(&both, &hold, session).is_err());
        let mut neither = value.clone();
        neither.as_object_mut().unwrap().remove("leaseId");
        assert!(published(&neither, &hold, session).is_err());
    }
    #[test]
    fn only_a_current_warm_hold_is_adopted_and_only_by_a_lease_that_names_it() {
        let hold = identity(Owner::Warm(HOLD.into()));
        let current = auth(1, 100.0, false);
        let claim = |from: Option<&str>, deadline: f64, fenced: bool| Published {
            owner: Owner::Lease(LEASE.into()),
            adopted_from: from.map(str::to_owned),
            terms: auth(3, deadline, fenced),
        };
        assert!(adoptable(
            &hold,
            &current,
            &claim(Some(HOLD), 500.0, false),
            50.0
        ));
        // First seen at or after the hold's deadline, or on a fenced hold: refused.
        assert!(!adoptable(
            &hold,
            &current,
            &claim(Some(HOLD), 500.0, false),
            100.0
        ));
        assert!(!adoptable(
            &hold,
            &auth(1, 100.0, true),
            &claim(Some(HOLD), 500.0, false),
            50.0
        ));
        // The lease's own terms must be current too.
        assert!(!adoptable(
            &hold,
            &current,
            &claim(Some(HOLD), 40.0, false),
            50.0
        ));
        assert!(!adoptable(
            &hold,
            &current,
            &claim(Some(HOLD), 500.0, true),
            50.0
        ));
        // A lease that names another hold, or none, never takes this device.
        assert!(!adoptable(
            &hold,
            &current,
            &claim(Some(LEASE), 500.0, false),
            50.0
        ));
        assert!(!adoptable(
            &hold,
            &current,
            &claim(None, 500.0, false),
            50.0
        ));
        // A warm hold never passes to another warm hold, and a lease is never adopted.
        let other_hold = Published {
            owner: Owner::Warm(LEASE.into()),
            adopted_from: Some(HOLD.into()),
            terms: auth(3, 500.0, false),
        };
        assert!(!adoptable(&hold, &current, &other_hold, 50.0));
        let leased = identity(Owner::Lease(MACHINE.into()));
        assert!(!adoptable(
            &leased,
            &current,
            &claim(Some(HOLD), 500.0, false),
            50.0
        ));
    }
    #[test]
    fn boot_session_is_a_uuid() {
        assert_eq!(boot_session().unwrap().len(), 36);
    }

    // Test clocks: a fixed origin, one that fails on every call after the first, and real
    // elapsed time for deadlines that must pass.
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
    fn real_clock() -> Result<f64> {
        static START: OnceLock<Instant> = OnceLock::new();
        Ok(1000.0 + START.get_or_init(Instant::now).elapsed().as_secs_f64())
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
    /// Publishes an authorization for `owner` and returns the matching launch request.
    fn publish(dir: &Path, owner: (&str, &str), revision: u64, deadline: f64, fenced: bool) {
        let mut value = json!({"version": 1, "machineId": MACHINE, "bootId": BOOT,
            "bootSessionID": boot_session().unwrap(), "revision": revision, "deadline": deadline, "fenced": fenced});
        value[owner.0] = json!(owner.1);
        save(dir, AUTHORIZATION, &value).unwrap();
    }
    fn launch(dir: &Path, owner: (&str, &str)) -> Value {
        let mut value = json!({"version": 1, "machineId": MACHINE, "bootId": BOOT, "executable": "/bin/sh",
            "args": ["-c", "sleep 30 & sleep 30"], "env": {}, "cwd": dir.to_str().unwrap()});
        value[owner.0] = json!(owner.1);
        value
    }
    fn request(dir: &Path, deadline: f64, fenced: bool) -> Value {
        publish(dir, ("leaseId", LEASE), 1, deadline, fenced);
        launch(dir, ("leaseId", LEASE))
    }
    fn group_alive(pgid: i32) -> bool {
        unsafe { libc::kill(-pgid, 0) == 0 }
    }
    fn wait_for(what: &str, check: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(20);
        while !check() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn record(dir: &Path, name: &str) -> Value {
        read_bounded(dir, name).unwrap().unwrap()
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
        // A launch must name exactly one owner, and its authorization must be that owner's.
        publish(&dir, ("leaseId", LEASE), 1, 5000.0, false);
        let mut both = launch(&dir, ("leaseId", LEASE));
        both["warmId"] = json!(HOLD);
        assert!(prepare(dir.to_str().unwrap(), &both, clock).is_err());
        assert!(prepare(
            dir.to_str().unwrap(),
            &launch(&dir, ("warmId", HOLD)),
            clock
        )
        .is_err());
        assert!(!dir.join(SUPERVISOR).exists());
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

    #[test]
    fn a_warm_hold_is_stopped_at_its_own_deadline_with_no_host_update() {
        let dir = storage("warm-expiry");
        let path = dir.to_str().unwrap().to_owned();
        publish(
            &dir,
            ("warmId", HOLD),
            1,
            real_clock().unwrap() + 0.6,
            false,
        );
        let prepared = prepare(&path, &launch(&dir, ("warmId", HOLD)), real_clock).unwrap();
        let mut spawned = None;
        // Nothing rewrites the authorization: the supervisor alone enforces the hold.
        let code = run(prepared, real_clock, |line| {
            spawned = line["childPid"].as_i64();
        });
        assert_eq!(code, 0);
        assert!(!group_alive(spawned.unwrap() as i32));
        let stopped = record(&dir, STOPPED);
        assert_eq!(stopped["reason"], "expired");
        assert_eq!(stopped["warmId"], HOLD);
        assert!(stopped.get("leaseId").is_none());
        assert_eq!(stopped["groupAbsent"], true);
        assert_eq!(record(&dir, FENCED)["warmId"], HOLD);
        assert_eq!(status(&path).unwrap(), "free");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_later_deadline_published_for_a_warm_hold_does_not_keep_the_device_alive() {
        let dir = storage("warm-extend");
        let path = dir.to_str().unwrap().to_owned();
        let start = real_clock().unwrap();
        publish(&dir, ("warmId", HOLD), 1, start + 0.8, false);
        let prepared = prepare(&path, &launch(&dir, ("warmId", HOLD)), real_clock).unwrap();
        let worker = std::thread::spawn(move || run(prepared, real_clock, |_| {}));
        wait_for("the supervisor record", || dir.join(SUPERVISOR).exists());
        let pid = record(&dir, SUPERVISOR)["childPid"].as_i64().unwrap() as i32;
        // Something rewrites the hold with a newer revision and a deadline a minute away.
        publish(&dir, ("warmId", HOLD), 7, start + 60.0, false);
        assert_eq!(worker.join().unwrap(), 0);
        assert!(
            real_clock().unwrap() < start + 10.0,
            "stopped at the original deadline"
        );
        assert!(!group_alive(pid));
        let stopped = record(&dir, STOPPED);
        assert_eq!(stopped["reason"], "expired");
        assert_eq!(stopped["warmId"], HOLD);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_lease_adopts_a_warm_hold_once_and_then_only_the_lease_is_enforced() {
        let dir = storage("adopt");
        let path = dir.to_str().unwrap().to_owned();
        let start = real_clock().unwrap();
        publish(&dir, ("warmId", HOLD), 1, start + 1.2, false);
        let prepared = prepare(&path, &launch(&dir, ("warmId", HOLD)), real_clock).unwrap();
        let worker = std::thread::spawn(move || run(prepared, real_clock, |_| {}));
        wait_for("the supervisor record", || dir.join(SUPERVISOR).exists());
        let warm = record(&dir, SUPERVISOR);
        assert_eq!(warm["warmId"], HOLD);
        assert!(warm.get("leaseId").is_none());
        let pid = warm["childPid"].as_i64().unwrap() as i32;
        // The lease's authorization replaces the hold's, naming the hold it adopts.
        let mut adoption = json!({"version": 1, "machineId": MACHINE, "bootId": BOOT, "leaseId": LEASE,
            "adoptedFrom": HOLD, "bootSessionID": boot_session().unwrap(), "revision": 4,
            "deadline": start + 60.0, "fenced": false});
        save(&dir, AUTHORIZATION, &adoption).unwrap();
        wait_for("the adoption record", || {
            record(&dir, SUPERVISOR)["leaseId"] == LEASE
        });
        let adopted = record(&dir, SUPERVISOR);
        assert_eq!(adopted["adoptedFrom"], HOLD);
        assert!(adopted.get("warmId").is_none());
        // Same boot, same emulator, same supervisor: nothing was relaunched.
        assert_eq!(adopted["childPid"], warm["childPid"]);
        assert_eq!(adopted["supervisorPid"], warm["supervisorPid"]);
        assert_eq!(adopted["bootId"], BOOT);
        // The hold's deadline no longer applies; the lease's does.
        while real_clock().unwrap() < start + 1.8 {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(
            group_alive(pid),
            "the adopted device outlives the hold's deadline"
        );
        assert!(!dir.join(STOPPED).exists());
        // An ordinary renewal of the adopting lease is accepted.
        adoption.as_object_mut().unwrap().remove("adoptedFrom");
        adoption["revision"] = json!(5);
        save(&dir, AUTHORIZATION, &adoption).unwrap();
        std::thread::sleep(Duration::from_millis(400));
        assert!(group_alive(pid));
        // A second lease can never take the device: any further owner change is a fence.
        let mut second = adoption.clone();
        second["leaseId"] = json!("66666666-6666-4666-8666-666666666666");
        second["adoptedFrom"] = json!(HOLD);
        save(&dir, AUTHORIZATION, &second).unwrap();
        assert_eq!(worker.join().unwrap(), 0);
        assert!(!group_alive(pid));
        let stopped = record(&dir, STOPPED);
        assert_eq!(stopped["reason"], "authorization");
        assert_eq!(stopped["leaseId"], LEASE);
        assert_eq!(stopped["adoptedFrom"], HOLD);
        assert_eq!(stopped["groupAbsent"], true);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_refused_adoption_stops_the_warm_device_and_never_hands_it_over() {
        for (name, from, lease_deadline) in [
            ("another-hold", "66666666-6666-4666-8666-666666666666", 60.0),
            ("ended-lease", HOLD, -1.0),
        ] {
            let dir = storage(name);
            let path = dir.to_str().unwrap().to_owned();
            let start = real_clock().unwrap();
            publish(&dir, ("warmId", HOLD), 1, start + 30.0, false);
            let prepared = prepare(&path, &launch(&dir, ("warmId", HOLD)), real_clock).unwrap();
            let worker = std::thread::spawn(move || run(prepared, real_clock, |_| {}));
            wait_for("the supervisor record", || dir.join(SUPERVISOR).exists());
            let pid = record(&dir, SUPERVISOR)["childPid"].as_i64().unwrap() as i32;
            let claim = json!({"version": 1, "machineId": MACHINE, "bootId": BOOT, "leaseId": LEASE,
                "adoptedFrom": from, "bootSessionID": boot_session().unwrap(), "revision": 2,
                "deadline": (start + lease_deadline).max(0.0), "fenced": false});
            save(&dir, AUTHORIZATION, &claim).unwrap();
            assert_eq!(worker.join().unwrap(), 0);
            assert!(!group_alive(pid));
            // The device ended as the warm hold it always was: the lease never owned it.
            let stopped = record(&dir, STOPPED);
            assert_eq!(stopped["reason"], "authorization");
            assert_eq!(stopped["warmId"], HOLD);
            assert!(stopped.get("leaseId").is_none());
            assert_eq!(record(&dir, SUPERVISOR)["warmId"], HOLD);
            std::fs::remove_dir_all(dir).unwrap();
        }
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
