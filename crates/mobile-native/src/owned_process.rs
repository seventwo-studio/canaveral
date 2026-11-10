//! Dedicated child process group with a WNOWAIT-pinned leader and kernel socket ownership.
use serde_json::{json, Value};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

#[path = "../../model-execution/src/socket_owner.rs"]
mod socket_owner;
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
#[derive(Default)]
pub struct OwnedProcess {
    child: Option<Child>,
    pgid: Option<i32>,
    reaped: bool,
    signalled: bool,
}
impl OwnedProcess {
    pub fn exited(&self) -> Result<bool> {
        let Some(child) = &self.child else {
            return Ok(true);
        };
        if self.reaped {
            return Ok(true);
        }
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        if unsafe {
            libc::waitid(
                libc::P_PID,
                child.id() as libc::id_t,
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        } != 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(unsafe { info.assume_init().si_pid() } == child.id() as i32)
    }
    fn group_absent(&self) -> bool {
        let Some(group) = self.pgid else {
            return true;
        };
        (unsafe { libc::kill(-group, 0) }) < 0
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }
    pub fn stop(&mut self, budget_ms: u64) -> Result<bool> {
        if self.child.is_none() {
            return Ok(true);
        }
        // Once reaped, even an unsuccessful cleanup can never authorize another signal.
        if self.reaped {
            return Ok(self.group_absent());
        }
        let deadline = Instant::now() + Duration::from_millis(budget_ms.min(30000));
        let group = self.pgid.ok_or("Missing owned group")?;
        if !self.signalled {
            // The leader remains an unreaped direct child: this PGID cannot be recycled.
            unsafe {
                libc::kill(-group, libc::SIGTERM);
            }
            self.signalled = true;
        }
        let grace = (Instant::now() + Duration::from_millis(200)).min(deadline);
        while Instant::now() < grace && !self.exited()? {
            std::thread::sleep(Duration::from_millis(5));
        }
        // Also kill detached work still in the dedicated group after its leader exited.
        unsafe {
            libc::kill(-group, libc::SIGKILL);
        }
        while Instant::now() < deadline && !self.exited()? {
            std::thread::sleep(Duration::from_millis(5));
        }
        if !self.exited()? {
            return Ok(false);
        }
        self.child.as_mut().unwrap().wait()?;
        self.reaped = true;
        while Instant::now() < deadline {
            if self.group_absent() {
                return Ok(true);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        Ok(self.group_absent())
    }
    pub fn handle(&mut self, v: &Value) -> Result<Value> {
        match v["op"].as_str().ok_or("Missing process op")? {
            "processSpawn" => {
                if self.child.is_some() {
                    return Err("Process scope already used".into());
                }
                let executable = v["executable"].as_str().ok_or("Missing executable")?;
                let cwd = v["cwd"].as_str().ok_or("Missing working directory")?;
                if !std::path::Path::new(executable).is_absolute()
                    || !std::path::Path::new(cwd).is_absolute()
                    || executable.contains('\0')
                    || cwd.contains('\0')
                {
                    return Err("Process paths must be absolute".into());
                }
                let args = v["args"].as_array().ok_or("Missing args")?;
                if args.len() > 100 {
                    return Err("Too many process args".into());
                }
                let mut cmd = Command::new(executable);
                for arg in args {
                    let s = arg.as_str().ok_or("Invalid process arg")?;
                    if s.len() > 16384 || s.contains('\0') {
                        return Err("Invalid process arg".into());
                    }
                    cmd.arg(s);
                }
                cmd.env_clear();
                let env = v["env"].as_object().ok_or("Missing scoped environment")?;
                if env.len() > 256 {
                    return Err("Environment exceeds envelope".into());
                }
                for (key, val) in env {
                    let val = val.as_str().ok_or("Invalid environment value")?;
                    if key.is_empty()
                        || key.contains(['=', '\0'])
                        || val.contains('\0')
                        || val.len() > 65536
                    {
                        return Err("Invalid environment".into());
                    }
                    cmd.env(key, val);
                }
                cmd.current_dir(cwd)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .process_group(0);
                let child = cmd.spawn()?;
                let pid = child.id();
                self.pgid = Some(pid as i32);
                self.child = Some(child);
                Ok(json!({"pid":pid}))
            }
            "processStatus" => Ok(json!({"exited":self.exited()?})),
            "processOwnsPort" => {
                let port = v["port"]
                    .as_u64()
                    .filter(|p| *p > 0 && *p <= 65535)
                    .ok_or("Invalid port")? as u16;
                let owned = if !self.reaped && !self.exited()? {
                    self.child
                        .as_ref()
                        .is_some_and(|c| socket_owner::owned(c.id(), port))
                } else {
                    false
                };
                Ok(json!({"owned":owned}))
            }
            "processStop" => Ok(
                json!({"stopped":self.stop(v["budgetMs"].as_u64().filter(|n|*n<=30000).ok_or("Invalid stop budget")?)?}),
            ),
            _ => Err("Invalid scoped process operation".into()),
        }
    }
}
impl Drop for OwnedProcess {
    fn drop(&mut self) {
        let _ = self.stop(2000);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn direct_child_stays_pinned_until_stop_and_never_signals_after_reap() {
        let mut p = OwnedProcess::default();
        p.handle(&json!({"op":"processSpawn","executable":"/bin/sh","args":["-c","exit 0"],"env":{},"cwd":"/"})).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while !p.exited().unwrap() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(p.exited().unwrap());
        assert!(!p.reaped);
        assert!(p.stop(1000).unwrap());
        assert!(p.reaped);
        assert!(p.stop(100).unwrap());
    }
    #[test]
    fn unrelated_loopback_listener_is_never_owned() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let mut p = OwnedProcess::default();
        p.handle(&json!({"op":"processSpawn","executable":"/bin/sleep","args":["30"],"env":{},"cwd":"/"})).unwrap();
        assert_eq!(
            p.handle(&json!({"op":"processOwnsPort","port":listener.local_addr().unwrap().port()}))
                .unwrap()["owned"],
            false
        );
        assert!(p.stop(1000).unwrap());
    }
}
