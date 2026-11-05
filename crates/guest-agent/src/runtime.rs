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
struct Running {
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
    fn start(
        id: Uuid,
        argv: Vec<String>,
        cwd: String,
        env: std::collections::BTreeMap<String, String>,
        timeout: u64,
        root: &std::path::Path,
    ) -> Result<Self> {
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
        #[cfg(all(target_os = "linux", not(test)))]
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
        let child = command.spawn()?;
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
    fn kill(&mut self) {
        if !self.killed {
            // Leader has not been reaped: its PID/PGID cannot be reused.
            unsafe {
                libc::kill(-(self.child.id() as i32), libc::SIGKILL);
            }
            // Production PID1 owns the entire guest process namespace. This also
            // fences descendants that escaped their original process group.
            #[cfg(not(test))]
            unsafe {
                libc::kill(-1, libc::SIGKILL);
            }
            self.killed = true;
        }
    }
    fn exited(&self) -> Result<bool> {
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
    fn finish(&mut self) -> Result<Guest> {
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
            let n = unsafe {
                libc::waitpid(
                    if cfg!(test) {
                        -(self.child.id() as i32)
                    } else {
                        -1
                    },
                    &mut status,
                    libc::WNOHANG,
                )
            };
            if n < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD) {
                // No further signals after reaping leader: never kill a reused PGID.
                confirmed = unsafe { libc::kill(-(self.child.id() as i32), 0) } < 0
                    && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
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
fn probe_tools(launch: &Launch) -> Result<()> {
    for (name, path, args) in [
        ("sh", "/bin/sh", vec!["-c", "exit 0"]),
        ("git", "/usr/bin/git", vec!["--version"]),
        ("node", "/usr/local/bin/node", vec!["--version"]),
        ("python3", "/usr/bin/python3", vec!["--version"]),
    ] {
        let mut child = Command::new(path)
            .args(args)
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let start = now();
        loop {
            if let Some(status) = child.try_wait()? {
                if !status.success() {
                    return Err("tool probe failed".into());
                }
                let mut output = String::new();
                child
                    .stdout
                    .take()
                    .unwrap()
                    .take(4096)
                    .read_to_string(&mut output)?;
                if name != "sh" && !output.contains(&launch.tool_versions[name]) {
                    return Err("tool version mismatch".into());
                }
                break;
            }
            if now() - start >= 2000 {
                child.kill()?;
                child.wait()?;
                return Err("tool probe timed out".into());
            }
            std::thread::sleep(Duration::from_millis(5));
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
fn reactor(mut transport: File, launch: &Launch, root: &std::path::Path) -> Result<()> {
    launch.validate()?;
    nonblock(transport.as_raw_fd())?;
    let mut decoder = Decoder::default();
    let mut authority: Option<Authority> = None;
    let mut running: Option<Running> = None;
    let mut last_id = Uuid::nil();
    let mut credit = 0u64;
    let mut pending = Vec::new();
    let mut sent = 0;
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
                match transport.write(&pending[sent..]) {
                    Ok(0) => return Err("disconnected".into()),
                    Ok(n) => sent += n,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(e) => return Err(e.into()),
                }
            }
            if sent == pending.len() {
                pending.clear();
                sent = 0;
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
                                running =
                                    Some(Running::start(id, argv, cwd, env, timeout_ms, root)?);
                            }
                            Host::Cancel { id, .. }
                                if running.as_ref().is_some_and(|r| r.id == id) =>
                            {
                                running.as_mut().unwrap().kill();
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
                        if credit == 0 || r.eof[stream] {
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
                        pending = encode(&receipt)?;
                        running = None;
                        if !confirmed {
                            let _ = transport.write(&pending);
                            return Err("termination unknown; native fence required".into());
                        }
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(2));
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
    use canaveral_guest_protocol::Binding;
    use std::{collections::BTreeMap, os::unix::net::UnixStream, thread};
    fn launch() -> Launch {
        #[cfg(target_os = "linux")]
        assert_eq!(
            unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) },
            0
        );
        Launch {
            binding: Binding {
                lease_id: Uuid::from_u128(1),
                member_id: Uuid::from_u128(2),
                boot_attempt: Uuid::from_u128(3),
                revision: 1,
                bundle_digest: "a".repeat(64),
            },
            workspace_bytes: 16 * 1024 * 1024,
            tool_versions: BTreeMap::from([
                ("git".into(), "1".into()),
                ("node".into(), "1".into()),
                ("python3".into(), "1".into()),
            ]),
        }
    }
    fn send(s: &mut UnixStream, h: Host) {
        s.write_all(&encode(&h).unwrap()).unwrap();
    }
    fn read(s: &mut UnixStream) -> Guest {
        let mut n = [0; 4];
        s.read_exact(&mut n).unwrap();
        let mut b = vec![0; u32::from_be_bytes(n) as usize];
        s.read_exact(&mut b).unwrap();
        serde_json::from_slice(&b).unwrap()
    }
    fn start(remaining: u64) -> (UnixStream, thread::JoinHandle<Result<()>>) {
        let (mut host, guest) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(4))).unwrap();
        let config = launch();
        let binding = config.binding.clone();
        let handle = thread::spawn(move || {
            let root = tempfile::tempdir()?;
            let fd: std::os::fd::OwnedFd = guest.into();
            reactor(File::from(fd), &config, root.path())
        });
        send(
            &mut host,
            Host::Hello {
                version: 1,
                binding,
                remaining_ms: remaining,
            },
        );
        assert!(matches!(read(&mut host), Guest::Ready { .. }));
        (host, handle)
    }
    fn exec(host: &mut UnixStream, cwd: &str, script: &str, timeout: u64) {
        send(
            host,
            Host::Exec {
                version: 1,
                id: Uuid::from_u128(10),
                argv: vec!["/bin/sh".into(), "-c".into(), script.into()],
                cwd: cwd.into(),
                env: BTreeMap::new(),
                timeout_ms: timeout,
            },
        );
    }
    #[test]
    fn invalid_cwd_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let (mut host, h) = start(3000);
        // Protocol requires /workspace even in fixtures; create path-independent command
        // by testing the process component directly below. Session rejects invalid cwd.
        exec(
            &mut host,
            dir.path().to_str().unwrap(),
            "printf hello",
            1000,
        );
        assert!(h.join().unwrap().is_err());
    }
    #[test]
    fn disposable_process_output_and_group_reap() {
        let _ = launch();
        let dir = tempfile::tempdir().unwrap();
        let mut r = Running::start(
            Uuid::from_u128(1),
            vec![
                "/bin/sh".into(),
                "-c".into(),
                "printf hello; printf error >&2; exit 7".into(),
            ],
            "/workspace".into(),
            BTreeMap::new(),
            1000,
            dir.path(),
        )
        .unwrap();
        let end = now() + 2000;
        while !r.exited().unwrap() && now() < end {
            thread::sleep(Duration::from_millis(5));
        }
        let mut out = String::new();
        r.child
            .stdout
            .as_mut()
            .unwrap()
            .read_to_string(&mut out)
            .unwrap();
        assert_eq!(out, "hello");
        assert!(matches!(
            r.finish().unwrap(),
            Guest::Exit {
                status: Some(7),
                termination_confirmed: true,
                ..
            }
        ));
    }
    #[test]
    fn stalled_partial_frame_and_disconnect_are_bounded() {
        let (mut host, h) = start(80);
        host.write_all(&[0, 0]).unwrap();
        assert!(h.join().unwrap().is_err());
        let (host, h) = start(3000);
        drop(host);
        assert!(h.join().unwrap().is_err());
    }
    #[test]
    fn stale_binding_and_unknown_fields_fail_closed() {
        let (mut host, h) = start(1000);
        let mut binding = launch().binding;
        binding.revision = 2;
        binding.member_id = Uuid::from_u128(99);
        send(
            &mut host,
            Host::Renew {
                version: 1,
                binding,
                remaining_ms: 1000,
            },
        );
        assert!(h.join().unwrap().is_err());
    }
    #[test]
    fn reactor_streams_and_reports_exit() {
        let (mut host, h) = start(3000);
        send(
            &mut host,
            Host::Credit {
                version: 1,
                bytes: 65536,
            },
        );
        exec(
            &mut host,
            "/workspace",
            "printf hello; printf error >&2; exit 7",
            1000,
        );
        let mut streams = BTreeMap::<String, Vec<u8>>::new();
        let mut seq = 0;
        loop {
            match read(&mut host) {
                Guest::Output {
                    stream,
                    seq: s,
                    data,
                    ..
                } => {
                    assert_eq!(s, seq);
                    seq += 1;
                    streams
                        .entry(stream)
                        .or_default()
                        .extend(STANDARD.decode(data).unwrap());
                }
                Guest::Exit {
                    status,
                    termination_confirmed,
                    stdout_bytes,
                    stderr_bytes,
                    ..
                } => {
                    assert_eq!(status, Some(7));
                    assert!(termination_confirmed);
                    assert_eq!((stdout_bytes, stderr_bytes), (5, 5));
                    break;
                }
                _ => panic!("unexpected receipt"),
            }
        }
        assert_eq!(streams["stdout"], b"hello");
        assert_eq!(streams["stderr"], b"error");
        exec(&mut host, "/workspace", "exit 0", 1000);
        assert!(h.join().unwrap().is_err());
    }
    #[test]
    fn timeout_and_cancel_kill_owned_group() {
        for cancel in [false, true] {
            let (mut host, h) = start(3000);
            send(
                &mut host,
                Host::Credit {
                    version: 1,
                    bytes: 65536,
                },
            );
            exec(
                &mut host,
                "/workspace",
                "sleep 30 & wait",
                if cancel { 2000 } else { 30 },
            );
            if cancel {
                send(
                    &mut host,
                    Host::Cancel {
                        version: 1,
                        id: Uuid::from_u128(10),
                    },
                );
            }
            loop {
                if let Guest::Exit {
                    timed_out,
                    termination_confirmed,
                    ..
                } = read(&mut host)
                {
                    assert_eq!(timed_out, !cancel);
                    assert!(termination_confirmed);
                    break;
                }
            }
            drop(host);
            assert!(h.join().unwrap().is_err());
        }
    }
    #[test]
    fn no_credit_does_not_block_expiry() {
        let (mut host, h) = start(100);
        exec(
            &mut host,
            "/workspace",
            "while :; do printf 1234567890; done",
            2000,
        );
        let before = now();
        assert!(h.join().unwrap().is_err());
        assert!(now() - before < 2000);
    }
    #[test]
    fn stalled_reader_does_not_block_deadline_or_disconnect() {
        for disconnect in [false, true] {
            let (mut host, h) = start(200);
            send(
                &mut host,
                Host::Credit {
                    version: 1,
                    bytes: MAX_FRAME as u64,
                },
            );
            exec(
                &mut host,
                "/workspace",
                "while :; do printf 123456789012345678901234567890; done",
                2000,
            );
            thread::sleep(Duration::from_millis(20));
            if disconnect {
                drop(host);
            }
            let before = now();
            assert!(h.join().unwrap().is_err());
            assert!(now() - before < 2000);
        }
    }
}
