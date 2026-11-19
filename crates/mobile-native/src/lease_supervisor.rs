//! Independent deadline owner for one leased Android emulator.
//!
//! The host publishes `lease-authorization.json` with an absolute deadline on this
//! boot's continuous clock. This process owns the emulator's dedicated process
//! group and stops it when that deadline passes, the authorization is fenced,
//! missing or changed, or this process is asked to terminate. It keeps running
//! when the host runner or controller is lost. Only a confirmed absent process
//! group produces `lease-stopped.json`; nothing else is a stop proof.
use serde_json::{json, Value};
use std::ffi::CString;
use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, Read, Write};
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
    fn absent(&self) -> bool {
        (unsafe { libc::kill(-self.pgid, 0) }) < 0
            && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }
    /// The leader stays an unreaped child until every signal is sent, so the PGID
    /// cannot be recycled. After reaping, the group is only observed, never signalled.
    fn stop(&mut self, grace: Duration) -> Result<i32> {
        if !self.exited()? {
            unsafe { libc::kill(-self.pgid, libc::SIGTERM) };
            let deadline = Instant::now() + grace;
            while Instant::now() < deadline && !self.exited()? {
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        loop {
            unsafe { libc::kill(-self.pgid, libc::SIGKILL) };
            if self.exited()? {
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        let status = self.child.wait()?;
        // Never exit while a group member may survive: a supervisor exit by status
        // therefore always means nothing it launched remains.
        while !self.absent() {
            std::thread::sleep(Duration::from_millis(20));
        }
        Ok(status.code().unwrap_or(-1))
    }
}

/// `lease-supervise <dir>` with one JSON launch request on stdin.
pub fn supervise(path: &str, elapsed: fn() -> Result<f64>) -> Result<()> {
    let dir = private_directory(path)?;
    let mut line = Vec::new();
    io::stdin()
        .lock()
        .take(1_048_577)
        .read_until(b'\n', &mut line)?;
    if line.len() > 1_048_576 || line.last() != Some(&b'\n') {
        return Err("Launch request exceeds its envelope".into());
    }
    let request: Value = serde_json::from_slice(&line)?;
    if request["version"] != 1 {
        return Err("Unsupported launch request".into());
    }
    let identity = json!({
        "machineId": uuid(&request, "machineId")?,
        "leaseId": uuid(&request, "leaseId")?,
        "bootId": uuid(&request, "bootId")?,
    });
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
    let mut current = authorization(
        &read_bounded(&dir, AUTHORIZATION)?.ok_or("Authorization is missing")?,
        &identity,
        &session,
    )?;
    if current.fenced || elapsed()? >= current.deadline {
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
    let log = OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(dir.join("emulator.log"))?;
    if !log.metadata()?.is_file() {
        return Err("Emulator log must be regular".into());
    }
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
        libc::signal(libc::SIGHUP, libc::SIG_IGN);
        libc::signal(libc::SIGTERM, terminate as *const () as libc::sighandler_t);
        libc::signal(libc::SIGINT, terminate as *const () as libc::sighandler_t);
    }
    let child = command
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .process_group(0)
        .spawn()?;
    let pid = child.id();
    let mut group = Group {
        child,
        pgid: pid as i32,
    };
    let started = elapsed()?;
    let record = json!({
        "version": 1, "machineId": identity["machineId"], "leaseId": identity["leaseId"],
        "bootId": identity["bootId"], "bootSessionID": session,
        "supervisorPid": std::process::id(), "childPid": pid, "startedAt": started,
    });
    let reason = match save(&dir, SUPERVISOR, &record) {
        Ok(()) => {
            // The host reads this one line; afterwards nothing is written to its pipe.
            let mut out = io::stdout().lock();
            let _ = writeln!(
                out,
                "{}",
                json!({"supervisorPid": std::process::id(), "childPid": pid})
            );
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
    let status = group.stop(Duration::from_secs(5))?;
    save(
        &dir,
        STOPPED,
        &json!({"version": 1, "machineId": identity["machineId"], "leaseId": identity["leaseId"],
                "bootId": identity["bootId"], "bootSessionID": session, "reason": reason,
                "supervisorPid": std::process::id(), "childPid": pid, "groupAbsent": true, "exitStatus": status}),
    )
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
}
