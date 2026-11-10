//! Guest-only compatibility transport. Protocol 1 PID1 boot remains a separate entry point.
//! Rust owns AF_VSOCK; Node owns the persistent classic worker. No TCP listener or host bridge.
use canaveral_guest_protocol::Result;

#[cfg(target_os = "linux")]
pub fn run() -> Result<()> {
    use std::{
        fs, io,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{
                fs::{MetadataExt, PermissionsExt},
                net::UnixStream,
            },
        },
        process::{Command, Stdio},
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        time::{Duration, Instant},
    };
    if unsafe { libc::geteuid() } == 0 || std::process::id() == 1 {
        return Err("classic worker requires an unprivileged Linux guest service".into());
    }
    if !std::env::args().any(|a| a == "--guest-confirmed") {
        return Err("classic worker requires --guest-confirmed inside an isolated VM".into());
    }
    let root = std::path::Path::new("/var/lib/seven");
    let metadata = fs::symlink_metadata(root)?;
    if !metadata.is_dir()
        || metadata.permissions().mode() & 0o077 != 0
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err("worker state must be an owned private nonsymlink directory".into());
    }
    let socket_path = root.join(format!("worker-{}.sock", std::process::id()));
    if socket_path.exists() {
        return Err("worker socket already exists".into());
    }
    let listener = unsafe {
        libc::socket(
            libc::AF_VSOCK,
            libc::SOCK_STREAM | libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK,
            0,
        )
    };
    if listener < 0 {
        return Err(io::Error::last_os_error().into());
    }
    let listener = unsafe { std::os::fd::OwnedFd::from_raw_fd(listener) };
    let mut addr: libc::sockaddr_vm = unsafe { std::mem::zeroed() };
    addr.svm_family = libc::AF_VSOCK as _;
    addr.svm_port = 7777;
    addr.svm_cid = libc::VMADDR_CID_ANY;
    if unsafe {
        libc::bind(
            listener.as_raw_fd(),
            (&addr as *const libc::sockaddr_vm).cast(),
            std::mem::size_of_val(&addr) as _,
        )
    } < 0
        || unsafe { libc::listen(listener.as_raw_fd(), 16) } < 0
    {
        return Err(io::Error::last_os_error().into());
    }
    // Fixed installed paths; consumer arguments cannot select a host executable or module.
    let mut child = Command::new("/usr/local/bin/node")
        .args([
            "/opt/seven/seven-agent.ts",
            "--worker-only",
            "--guest-confirmed",
        ])
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("HOME", root)
        .env("CANAVERAL_WORKER_SOCKET", &socket_path)
        .stdin(Stdio::null())
        .spawn()?;
    let result = (|| -> Result<()> {
        let start = Instant::now();
        while !socket_path.exists() {
            if let Some(status) = child.try_wait()? {
                return Err(format!("Node worker exited before readiness: {status}").into());
            }
            if start.elapsed() >= Duration::from_secs(10) {
                return Err("Node worker socket readiness timed out".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let count = Arc::new(AtomicUsize::new(0));
        loop {
            if let Some(status) = child.try_wait()? {
                return if status.success() {
                    Ok(())
                } else {
                    Err(format!("Node worker exited: {status}").into())
                };
            }
            let mut peer: libc::sockaddr_vm = unsafe { std::mem::zeroed() };
            let mut size = std::mem::size_of_val(&peer) as libc::socklen_t;
            let fd = unsafe {
                libc::accept4(
                    listener.as_raw_fd(),
                    (&mut peer as *mut libc::sockaddr_vm).cast(),
                    &mut size,
                    libc::SOCK_CLOEXEC,
                )
            };
            if fd < 0 {
                let e = io::Error::last_os_error();
                if e.kind() == io::ErrorKind::WouldBlock || e.kind() == io::ErrorKind::Interrupted {
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                }
                return Err(e.into());
            }
            // The trusted host is the only admitted origin; no guest-to-guest worker channel.
            // UnixStream wraps an owned stream FD; only read/write/shutdown/socket options are used.
            let client = unsafe { UnixStream::from_raw_fd(fd) };
            if size as usize != std::mem::size_of_val(&peer)
                || peer.svm_cid != libc::VMADDR_CID_HOST
                || count.load(Ordering::Acquire) >= 16
            {
                drop(client);
                continue;
            }
            let path = socket_path.clone();
            let count = Arc::clone(&count);
            count.fetch_add(1, Ordering::AcqRel);
            std::thread::spawn(move || {
                let _ = (|| -> io::Result<()> {
                    use std::net::Shutdown;
                    // Commands have a 60s bound; receipt and teardown have a separate margin.
                    client.set_read_timeout(Some(Duration::from_secs(80)))?;
                    client.set_write_timeout(Some(Duration::from_secs(20)))?;
                    let mut local = UnixStream::connect(path)?;
                    local.set_read_timeout(Some(Duration::from_secs(80)))?;
                    local.set_write_timeout(Some(Duration::from_secs(20)))?;
                    let mut client_read = client.try_clone()?;
                    let mut local_write = local.try_clone()?;
                    let inbound = std::thread::spawn(move || {
                        let _ = io::copy(&mut client_read, &mut local_write);
                        let _ = local_write.shutdown(Shutdown::Write);
                    });
                    let mut client_write = client;
                    let _ = io::copy(&mut local, &mut client_write);
                    let _ = client_write.shutdown(Shutdown::Both);
                    let _ = local.shutdown(Shutdown::Both);
                    let _ = inbound.join();
                    Ok(())
                })();
                count.fetch_sub(1, Ordering::AcqRel);
            });
        }
    })();
    let _ = child.kill();
    let _ = child.wait();
    // Only the path belonging to this process is eligible for cleanup.
    let _ = fs::remove_file(socket_path);
    result
}

#[cfg(not(target_os = "linux"))]
pub fn run() -> Result<()> {
    Err("classic worker requires Linux".into())
}

#[cfg(test)]
mod tests {
    #[test]
    fn classic_worker_refuses_unguarded_library_invocation() {
        // Refusal precedes filesystem, socket, or process effects on every platform.
        assert!(super::run().is_err());
    }
}
