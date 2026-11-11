//! Nonblocking single-session reactor; transport stalls cannot stall supervision.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]
use crate::Launch;
use base64::{engine::general_purpose::STANDARD, Engine};
use canaveral_guest_protocol::{encode, Authority, Decoder, Guest, Host, Result, MAX_FRAME};
use std::{
    fs::File,
    io::{Read, Write},
    os::{
        fd::{AsRawFd, RawFd},
        unix::process::{CommandExt, ExitStatusExt},
    },
    process::{Child, Command, Stdio},
    time::Duration,
};
use uuid::Uuid;
const CHUNK: usize = 8192;
fn nonblock(fd: RawFd) -> Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}
fn write_pending(writer: &mut impl Write, pending: &[u8], sent: &mut usize) -> Result<()> {
    match writer.write(&pending[*sent..]) {
        Ok(0) => Err("disconnected".into()),
        Ok(n) => {
            *sent += n;
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => Ok(()),
        Err(e) => Err(e.into()),
    }
}
pub(crate) fn now() -> u64 {
    let mut t = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    #[cfg(target_os = "linux")]
    let clock = libc::CLOCK_BOOTTIME;
    #[cfg(not(target_os = "linux"))]
    let clock = libc::CLOCK_MONOTONIC;
    if unsafe { libc::clock_gettime(clock, &mut t) } != 0 {
        std::process::abort();
    }
    (t.tv_sec as u64).saturating_mul(1000) + t.tv_nsec as u64 / 1_000_000
}
pub(crate) struct Running {
    child: Child,
    id: Uuid,
    start: u64,
    timeout: u64,
    seq: u64,
    counts: [u64; 2],
    eof: [bool; 2],
    timed_out: bool,
    killed: bool,
}
impl Running {
    pub(crate) fn start(
        id: Uuid,
        argv: Vec<String>,
        cwd: String,
        env: std::collections::BTreeMap<String, String>,
        timeout: u64,
        root: &std::path::Path,
    ) -> Result<Self> {
        require_pid1()?;
        let child = (|| -> Result<Child> {
            let root = std::fs::canonicalize(root)?;
            let relative = std::path::Path::new(&cwd).strip_prefix("/workspace")?;
            let path = std::fs::canonicalize(root.join(relative))?;
            if !path.starts_with(&root) {
                return Err("cwd outside workspace".into());
            }
            let mut command = Command::new(&argv[0]);
            command
                .args(&argv[1..])
                .current_dir(path)
                .env_clear()
                .env("PATH", "/usr/local/bin:/usr/bin:/bin")
                .envs(env)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .process_group(0);
            // Guest commands cannot replace PID1 or its trusted launch configuration.
            #[cfg(target_os = "linux")]
            unsafe {
                command.pre_exec(|| {
                    if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
                        || libc::setgroups(0, std::ptr::null()) != 0
                        || libc::setgid(1000) != 0
                        || libc::setuid(1000) != 0
                    {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            Ok(command.spawn()?)
        })()
        .map_err(|_| Box::new(SpawnFailed) as Box<dyn std::error::Error + Send + Sync>)?;
        let mut running = Self {
            child,
            id,
            start: now(),
            timeout,
            seq: 0,
            counts: [0; 2],
            eof: [false; 2],
            timed_out: false,
            killed: false,
        };
        if let Err(e) = nonblock(running.child.stdout.as_ref().unwrap().as_raw_fd())
            .and_then(|_| nonblock(running.child.stderr.as_ref().unwrap().as_raw_fd()))
        {
            running.kill();
            return Err(e);
        }
        Ok(running)
    }
    pub(crate) fn kill(&mut self) {
        if !self.killed {
            require_pid1().expect("namespace-wide kill requires PID1");
            // Leader has not been reaped: its PID/PGID cannot be reused.
            unsafe {
                libc::kill(-(self.child.id() as i32), libc::SIGKILL);
            }
            // Production PID1 owns the entire guest process namespace. This also
            // fences descendants that escaped their original process group.
            unsafe {
                libc::kill(-1, libc::SIGKILL);
            }
            self.killed = true;
        }
    }
    pub(crate) fn exited(&self) -> Result<bool> {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        if unsafe {
            libc::waitid(
                libc::P_PID,
                self.child.id(),
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        } != 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(unsafe { info.si_pid() } != 0)
    }
    fn reap_orphans(&self) -> Result<()> {
        #[cfg(target_os = "linux")]
        for pid in std::fs::read_to_string("/proc/self/task/1/children")?.split_whitespace() {
            let pid: i32 = pid.parse()?;
            if pid != self.child.id() as i32 {
                // Reap only this adopted direct child; never reap the retained leader.
                unsafe {
                    libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG);
                }
            }
        }
        Ok(())
    }
    pub(crate) fn finish(&mut self) -> Result<Guest> {
        self.kill();
        // Bound cleanup, retaining leader ownership until it is waitable.
        let deadline = now() + 1000;
        while !self.exited()? && now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        if !self.exited()? {
            return Ok(self.receipt(None, None, false));
        }
        let status = self.child.wait()?;
        let mut confirmed = false;
        loop {
            let mut status = 0;
            let n = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
            if n < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD) {
                // No further signals after reaping leader: never kill a reused PGID.
                confirmed = true;
                break;
            }
            if now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        Ok(self.receipt(status.code(), status.signal(), confirmed))
    }
    fn receipt(&self, status: Option<i32>, signal: Option<i32>, confirmed: bool) -> Guest {
        Guest::Exit {
            version: 1,
            id: self.id,
            status,
            signal,
            timed_out: self.timed_out,
            duration_ms: now().saturating_sub(self.start),
            stdout_bytes: self.counts[0],
            stderr_bytes: self.counts[1],
            termination_confirmed: confirmed,
        }
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        self.kill(); /* Never release or replay an unconfirmed child. */
    }
}
#[derive(Debug)]
struct SpawnFailed;
impl std::fmt::Display for SpawnFailed {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("spawn failed before exec")
    }
}
impl std::error::Error for SpawnFailed {}
fn require_pid1() -> Result<()> {
    if !cfg!(target_os = "linux") || std::process::id() != 1 {
        return Err("production supervision requires Linux PID1".into());
    }
    Ok(())
}
fn probe_matches(success: bool, output: &str, pin: &str) -> bool {
    success && output.lines().next().is_some_and(|line| line.trim() == pin)
}
const TOOL_PROBES: [(&str, &str, &[&str]); 3] = [
    (
        "shell",
        "/bin/sh",
        &["-c", "printf 'canaveral-shell-v1\\n'"],
    ),
    ("git", "/usr/bin/git", &["--version"]),
    ("node", "/usr/local/bin/node", &["--version"]),
];
/// Both leader completion and pipe EOF must arrive within the probe budget.
/// A descendant retaining stdout must not turn readiness into an unbounded read.
fn collect_probe_output(
    mut stdout: impl Read + AsRawFd,
    mut exited: impl FnMut() -> Result<Option<bool>>,
    timeout_ms: u64,
) -> Result<String> {
    nonblock(stdout.as_raw_fd())?;
    let deadline = now().saturating_add(timeout_ms);
    let mut output = Vec::new();
    let mut eof = false;
    let mut success = false;
    loop {
        if now() >= deadline {
            return Err("tool probe timed out".into());
        }
        if !success {
            match exited()? {
                Some(false) => return Err("tool probe failed".into()),
                Some(true) => success = true,
                None => {}
            }
        }
        if !eof {
            let mut buffer = [0; 1024];
            match stdout.read(&mut buffer) {
                Ok(0) => eof = true,
                Ok(n) => {
                    if output.len() + n > 4096 {
                        return Err("tool probe output exceeds limit".into());
                    }
                    output.extend_from_slice(&buffer[..n]);
                    continue;
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e.into()),
            }
        }
        if success && eof {
            return Ok(String::from_utf8(output)?);
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn probe_tools(launch: &Launch) -> Result<()> {
    for (name, path, args) in TOOL_PROBES {
        let mut child = Command::new(path)
            .args(args)
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let stdout = child.stdout.take().ok_or("missing probe stdout")?;
        let output = collect_probe_output(
            stdout,
            || Ok(child.try_wait()?.map(|status| status.success())),
            2000,
        );
        if output.is_err() {
            // An exited leader may already be reaped; Child::kill will not signal
            // a reused PID. PID1 exits on probe failure, fencing the guest.
            let _ = child.kill();
            let _ = child.try_wait();
        }
        if !probe_matches(true, &output?, &launch.manifest.tool_versions[name]) {
            return Err("tool version mismatch".into());
        }
    }
    Ok(())
}
/// Only boot calls this in production. Tests inject an owned stream and launch scope.
pub(crate) fn session(transport: File, launch: &Launch) -> Result<()> {
    if std::process::id() != 1 {
        return Err("guest session requires PID1".into());
    }
    reactor(transport, launch, std::path::Path::new("/workspace"))
}
pub(crate) fn reactor(mut transport: File, launch: &Launch, root: &std::path::Path) -> Result<()> {
    launch.validate()?;
    nonblock(transport.as_raw_fd())?;
    let mut decoder = Decoder::default();
    let mut authority: Option<Authority> = None;
    let mut running: Option<Running> = None;
    let mut last_id = Uuid::nil();
    let mut completed_id = Uuid::nil();
    let mut credit = 0u64;
    let mut pending = Vec::new();
    let mut sent = 0;
    let mut rejection = None;
    let mut close_after_frame = false;
    let connected = now();
    let result = (|| -> Result<()> {
        loop {
            let time = now();
            if authority.as_mut().is_some_and(|a| !a.permits(time))
                || (authority.is_none() && time - connected >= 5000)
            {
                return Err("authority expired".into());
            }
            if let Some(r) = running.as_mut() {
                // Transport drain time does not turn an already completed or
                // cancelled process into a timed-out execution.
                r.reap_orphans()?;
                if r.exited()? {
                    r.kill();
                }
                if !r.killed && time.saturating_sub(r.start) >= r.timeout {
                    r.timed_out = true;
                    r.kill();
                }
            }
            // One bounded write frame; all writes are nonblocking.
            if sent < pending.len() {
                write_pending(&mut transport, &pending, &mut sent)?;
            }
            if sent == pending.len() {
                pending.clear();
                sent = 0;
                if close_after_frame {
                    return Err("termination unknown; native fence required".into());
                }
                if let Some(id) = rejection.take() {
                    pending = encode(&Guest::Rejected {
                        version: 1,
                        id,
                        reason: "unknownCommand".into(),
                    })?;
                }
            }
            // Read bounded work each tick so a hostile sender cannot starve deadlines.
            let mut buffer = [0u8; CHUNK];
            let wanted = decoder.needed().min(CHUNK);
            match transport.read(&mut buffer[..wanted]) {
                Ok(0) => return Err("disconnected".into()),
                Ok(n) => {
                    if let Some(message) = decoder.feed(&buffer[..n])? {
                        match message {
                            Host::Hello {
                                binding,
                                remaining_ms,
                                ..
                            } if authority.is_none() => {
                                if binding != launch.binding {
                                    return Err("launch binding mismatch".into());
                                }
                                // Boot probes before accept; no blocking probes inside authorized reactor.
                                authority =
                                    Some(Authority::new(binding.clone(), remaining_ms, time)?);
                                if !pending.is_empty() {
                                    return Err("pending hello".into());
                                }
                                pending = encode(&Guest::Ready {
                                    version: 1,
                                    binding,
                                })?;
                            }
                            Host::Renew {
                                binding,
                                remaining_ms,
                                ..
                            } => authority.as_mut().ok_or("hello required")?.renew(
                                binding,
                                remaining_ms,
                                time,
                            )?,
                            Host::Credit { bytes, .. } if authority.is_some() => {
                                credit = credit
                                    .checked_add(bytes)
                                    .filter(|n| *n <= MAX_FRAME as u64)
                                    .ok_or("credit overflow")?;
                            }
                            Host::Exec {
                                id,
                                argv,
                                cwd,
                                env,
                                timeout_ms,
                                ..
                            } if authority.is_some() && running.is_none() && pending.is_empty() => {
                                if id <= last_id {
                                    return Err("exec replay or unordered UUID".into());
                                }
                                last_id = id;
                                match Running::start(id, argv, cwd, env, timeout_ms, root) {
                                    Ok(r) => running = Some(r),
                                    Err(e) if e.is::<SpawnFailed>() => {
                                        completed_id = id;
                                        pending = encode(&Guest::SpawnFailed { version: 1, id })?
                                    }
                                    Err(e) => return Err(e),
                                }
                            }
                            Host::Cancel { id, .. }
                                if running.as_ref().is_some_and(|r| r.id == id) =>
                            {
                                running.as_mut().unwrap().kill();
                            }
                            Host::Cancel { id, .. }
                                if authority.is_some() && id == completed_id => {}
                            Host::Cancel { id, .. } if authority.is_some() => {
                                if rejection.replace(id).is_some() {
                                    return Err("too many pending rejections".into());
                                }
                            }
                            _ => return Err("invalid session transition".into()),
                        }
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(e) => return Err(e.into()),
            }
            if pending.is_empty() {
                if let Some(r) = running.as_mut() {
                    for stream in 0..2 {
                        if r.eof[stream] {
                            continue;
                        }
                        if credit == 0 {
                            let fd = if stream == 0 {
                                r.child.stdout.as_ref().unwrap().as_raw_fd()
                            } else {
                                r.child.stderr.as_ref().unwrap().as_raw_fd()
                            };
                            let mut p = libc::pollfd {
                                fd,
                                events: libc::POLLIN,
                                revents: 0,
                            };
                            let mut available: libc::c_int = 0;
                            unsafe {
                                libc::poll(&mut p, 1, 0);
                                libc::ioctl(fd, libc::FIONREAD, &mut available);
                            }
                            if p.revents & libc::POLLHUP != 0 && available == 0 {
                                r.eof[stream] = true;
                            }
                            continue;
                        }
                        let wanted = (credit as usize).min(CHUNK);
                        let read = if stream == 0 {
                            r.child.stdout.as_mut().unwrap().read(&mut buffer[..wanted])
                        } else {
                            r.child.stderr.as_mut().unwrap().read(&mut buffer[..wanted])
                        };
                        match read {
                            Ok(0) => r.eof[stream] = true,
                            Ok(n) => {
                                credit -= n as u64;
                                r.counts[stream] += n as u64;
                                pending = encode(&Guest::Output {
                                    version: 1,
                                    id: r.id,
                                    stream: if stream == 0 { "stdout" } else { "stderr" }.into(),
                                    seq: r.seq,
                                    data: STANDARD.encode(&buffer[..n]),
                                })?;
                                r.seq = r.seq.checked_add(1).ok_or("sequence overflow")?;
                                break;
                            }
                            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                            Err(e) => return Err(e.into()),
                        }
                    }
                    if r.eof == [true; 2] && pending.is_empty() && r.exited()? {
                        let receipt = r.finish()?;
                        let confirmed = matches!(
                            receipt,
                            Guest::Exit {
                                termination_confirmed: true,
                                ..
                            }
                        );
                        completed_id = r.id;
                        pending = encode(&receipt)?;
                        running = None;
                        if !confirmed {
                            close_after_frame = true;
                        }
                    }
                }
            }
            let time = now();
            let mut deadline = authority
                .as_ref()
                .map_or(connected + 5000, Authority::deadline);
            if let Some(r) = &running {
                if !r.killed {
                    deadline = deadline.min(r.start.saturating_add(r.timeout));
                }
            }
            // Child exit/adoption has no pipe event if a descendant retains the pipe.
            // A bounded 25ms supervision tick handles it while IO wakes immediately.
            let timeout = deadline.saturating_sub(time).min(25) as i32;
            let mut fds = vec![libc::pollfd {
                fd: transport.as_raw_fd(),
                events: libc::POLLIN | if pending.is_empty() { 0 } else { libc::POLLOUT },
                revents: 0,
            }];
            if pending.is_empty() && credit > 0 {
                if let Some(r) = &running {
                    for (fd, eof) in [
                        (r.child.stdout.as_ref().unwrap().as_raw_fd(), r.eof[0]),
                        (r.child.stderr.as_ref().unwrap().as_raw_fd(), r.eof[1]),
                    ] {
                        if !eof {
                            fds.push(libc::pollfd {
                                fd,
                                events: libc::POLLIN,
                                revents: 0,
                            });
                        }
                    }
                }
            }
            // Already buffered frames can be written on the next iteration immediately.
            unsafe {
                libc::poll(fds.as_mut_ptr(), fds.len() as _, timeout);
            }
        }
    })();
    if let Some(a) = authority.as_mut() {
        a.fence();
    }
    if let Some(r) = running.as_mut() {
        r.kill();
        let _ = r.finish();
    }
    result
}
pub(crate) fn probes(launch: &Launch) -> Result<()> {
    probe_tools(launch)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixStream;
    fn control_pair(
        jammed: bool,
    ) -> (
        UnixStream,
        canaveral_guest_protocol::Binding,
        std::thread::JoinHandle<String>,
    ) {
        let manifest: canaveral_guest_protocol::bundle::Manifest = serde_json::from_slice(
            include_bytes!("../../guest-protocol/fixtures/canonical.json"),
        )
        .unwrap();
        let binding = canaveral_guest_protocol::Binding {
            lease_id: Uuid::from_u128(1),
            member_id: Uuid::from_u128(2),
            revision: 1,
            boot_attempt: Uuid::from_u128(3),
            bundle_digest: manifest.digest().unwrap(),
        };
        let launch = Launch {
            binding: binding.clone(),
            workspace_bytes: 16777216,
            manifest,
        };
        let root = tempfile::tempdir().unwrap();
        let (host, guest) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let fd: std::os::fd::OwnedFd = guest.into();
        let mut guest = File::from(fd);
        if jammed {
            nonblock(guest.as_raw_fd()).unwrap();
            loop {
                match guest.write(&[0; 8192]) {
                    Ok(_) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                    other => panic!("cannot fill transport: {other:?}"),
                }
            }
        }
        let worker = std::thread::spawn(move || {
            reactor(guest, &launch, root.path())
                .unwrap_err()
                .to_string()
        });
        (host, binding, worker)
    }
    fn send(host: &mut UnixStream, frame: Host) {
        host.write_all(&encode(&frame).unwrap()).unwrap();
    }
    fn receive(host: &mut UnixStream) -> Guest {
        let mut size = [0; 4];
        host.read_exact(&mut size).unwrap();
        let n = u32::from_be_bytes(size) as usize;
        assert!(n <= MAX_FRAME);
        let mut body = vec![0; n];
        host.read_exact(&mut body).unwrap();
        serde_json::from_slice(&body).unwrap()
    }
    fn hello(host: &mut UnixStream, binding: canaveral_guest_protocol::Binding, remaining_ms: u64) {
        send(
            host,
            Host::Hello {
                version: 1,
                binding: binding.clone(),
                remaining_ms,
            },
        );
        assert!(matches!(receive(host), Guest::Ready {binding: actual, ..} if actual == binding));
    }
    #[test]
    fn reactor_hello_ready_and_disconnect_without_execution() {
        let (mut host, binding, worker) = control_pair(false);
        hello(&mut host, binding, 1000);
        drop(host);
        assert!(worker.join().unwrap().contains("disconnected"));
    }
    #[test]
    fn reactor_binding_mismatch_without_execution() {
        let (mut host, mut binding, worker) = control_pair(false);
        binding.member_id = Uuid::from_u128(9);
        send(
            &mut host,
            Host::Hello {
                version: 1,
                binding,
                remaining_ms: 1000,
            },
        );
        assert!(worker.join().unwrap().contains("binding mismatch"));
    }
    #[test]
    fn reactor_stale_renew_fences_without_execution() {
        let (mut host, binding, worker) = control_pair(false);
        hello(&mut host, binding.clone(), 1000);
        send(
            &mut host,
            Host::Renew {
                version: 1,
                binding,
                remaining_ms: 1000,
            },
        );
        assert!(!worker.join().unwrap().is_empty());
    }
    #[test]
    fn reactor_partial_frame_does_not_delay_expiry() {
        let (mut host, binding, worker) = control_pair(false);
        hello(&mut host, binding, 40);
        host.write_all(&[0, 0]).unwrap();
        assert!(worker.join().unwrap().contains("expired"));
    }
    #[test]
    fn reactor_unknown_cancel_rejects_and_preserves_session() {
        let (mut host, binding, worker) = control_pair(false);
        hello(&mut host, binding.clone(), 1000);
        let id = Uuid::from_u128(10);
        send(&mut host, Host::Cancel { version: 1, id });
        assert!(
            matches!(receive(&mut host), Guest::Rejected {id: actual, reason, ..} if actual == id && reason == "unknownCommand")
        );
        let mut renewed = binding;
        renewed.revision += 1;
        send(
            &mut host,
            Host::Renew {
                version: 1,
                binding: renewed,
                remaining_ms: 1000,
            },
        );
        send(&mut host, Host::Cancel { version: 1, id });
        assert!(matches!(receive(&mut host), Guest::Rejected {id: actual, ..} if actual == id));
        drop(host);
        assert!(worker.join().unwrap().contains("disconnected"));
    }
    #[test]
    fn reactor_second_queued_rejection_fences_under_backpressure() {
        let (mut host, binding, worker) = control_pair(true);
        send(
            &mut host,
            Host::Hello {
                version: 1,
                binding,
                remaining_ms: 1000,
            },
        );
        for n in [10, 11] {
            send(
                &mut host,
                Host::Cancel {
                    version: 1,
                    id: Uuid::from_u128(n),
                },
            );
        }
        assert!(worker.join().unwrap().contains("pending rejections"));
    }
    #[test]
    fn reactor_exec_before_hello_never_starts_a_process() {
        let (mut host, _, worker) = control_pair(false);
        send(
            &mut host,
            Host::Exec {
                version: 1,
                id: Uuid::from_u128(10),
                argv: vec!["/must-not-execute".into()],
                cwd: "/workspace".into(),
                env: Default::default(),
                timeout_ms: 1000,
            },
        );
        assert!(worker
            .join()
            .unwrap()
            .contains("invalid session transition"));
    }
    #[test]
    fn partial_frame_offsets_survive_backpressure() {
        struct Partial {
            bytes: Vec<u8>,
            blocked: bool,
        }
        impl Write for Partial {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.blocked = !self.blocked;
                if self.blocked {
                    return Err(std::io::ErrorKind::WouldBlock.into());
                }
                self.bytes.push(b[0]);
                Ok(1)
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let frame = encode(&Guest::Rejected {
            version: 1,
            id: Uuid::from_u128(1),
            reason: "unknownCommand".into(),
        })
        .unwrap();
        let mut writer = Partial {
            bytes: vec![],
            blocked: false,
        };
        let mut sent = 0;
        while sent < frame.len() {
            write_pending(&mut writer, &frame, &mut sent).unwrap();
        }
        assert_eq!(writer.bytes, frame);
        assert!(write_pending(&mut std::io::sink(), &[], &mut 0).is_err());
    }
    #[test]
    fn probe_capture_requires_exit_and_eof() {
        let (reader, mut writer) = UnixStream::pair().unwrap();
        writer.write_all(b"v24.11.0\n").unwrap();
        writer.shutdown(std::net::Shutdown::Write).unwrap();
        assert_eq!(
            collect_probe_output(reader, || Ok(Some(true)), 1000).unwrap(),
            "v24.11.0\n"
        );

        let (reader, writer) = UnixStream::pair().unwrap();
        drop(writer);
        assert_eq!(
            collect_probe_output(reader, || Ok(None), 25)
                .unwrap_err()
                .to_string(),
            "tool probe timed out"
        );
    }
    #[test]
    fn probe_exited_leader_with_inherited_stdout_is_bounded() {
        let (reader, mut writer) = UnixStream::pair().unwrap();
        writer.write_all(b"v24.11.0\n").unwrap();
        // Model an exited leader whose descendant still holds its stdout open.
        assert_eq!(
            collect_probe_output(reader, || Ok(Some(true)), 25)
                .unwrap_err()
                .to_string(),
            "tool probe timed out"
        );
    }
    #[test]
    fn probe_drains_before_exit_and_rejects_excess_output() {
        let (reader, mut writer) = UnixStream::pair().unwrap();
        writer.write_all(&[b'x'; 4097]).unwrap();
        assert_eq!(
            collect_probe_output(reader, || Ok(None), 1000)
                .unwrap_err()
                .to_string(),
            "tool probe output exceeds limit"
        );
    }
    #[test]
    fn probe_rejects_failed_exit_without_waiting_for_stdout() {
        let (reader, _writer) = UnixStream::pair().unwrap();
        assert_eq!(
            collect_probe_output(reader, || Ok(Some(false)), 1000)
                .unwrap_err()
                .to_string(),
            "tool probe failed"
        );
    }
    #[test]
    fn exact_probe_lines() {
        assert_eq!(TOOL_PROBES.map(|probe| probe.0), ["shell", "git", "node"]);
        assert!(probe_matches(true, "  v24.11.0\nother", "v24.11.0"));
        assert!(!probe_matches(false, "v24.11.0", "v24.11.0"));
        for bad in ["v24.11.01", "prefix v24.11.0", "wrong\nv24.11.0", ""] {
            assert!(!probe_matches(true, bad, "v24.11.0"));
        }
    }
    #[test]
    fn host_cannot_supervise() {
        assert!(require_pid1().is_err());
    }
}
