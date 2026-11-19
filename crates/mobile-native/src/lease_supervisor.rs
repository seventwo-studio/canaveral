//! Independent deadline owner for one leased Android emulator.
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

/// Everything validated before anything is spawned. Holding it holds the lifetime lock.
pub struct Prepared {
    dir: PathBuf,
    identity: Value,
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
        identity,
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
    let record = json!({
        "version": 1, "machineId": identity["machineId"], "leaseId": identity["leaseId"],
        "bootId": identity["bootId"], "bootSessionID": session,
        "supervisorPid": std::process::id(), "childPid": pid, "startedAt": started,
    });
    let reason = match save(&dir, SUPERVISOR, &record) {
        Ok(()) => {
            announce(&json!({"supervisorPid": std::process::id(), "childPid": pid}));
            watch(&dir, &identity, &session, &mut current, &group, elapsed)
        }
        Err(_) => "record",
    };
    if reason != "exited" {
        // A failed sticky marker must never prevent stopping the group.
        let _ = save(
            &dir,
            FENCED,
            &json!({"version": 1, "machineId": identity["machineId"], "leaseId": identity["leaseId"],
                "bootId": identity["bootId"], "reason": reason}),
        );
    }
    let status = group.stop(Duration::from_secs(5));
    let receipt = json!({"version": 1, "machineId": identity["machineId"], "leaseId": identity["leaseId"],
        "bootId": identity["bootId"], "bootSessionID": session, "reason": reason,
        "supervisorPid": std::process::id(), "childPid": pid, "groupAbsent": true, "exitStatus": status});
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

fn watch(
    dir: &Path,
    identity: &Value,
    session: &str,
    current: &mut Authorization,
    group: &Group,
    elapsed: fn() -> Result<f64>,
) -> &'static str {
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
            Ok(Some(value)) => match authorization(&value, identity, session) {
                Ok(next) => next,
                Err(_) => return "authorization",
            },
            _ => return "authorization",
        };
        *current = advance(current, &next, now);
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
