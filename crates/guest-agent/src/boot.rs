use crate::{launch::BootLaunch, runtime};
use canaveral_guest_protocol::Result;
use std::{
    ffi::CString,
    fs::{self, File},
    io::Read,
    os::{
        fd::FromRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
};
pub(crate) fn mount(
    source: &str,
    target: &str,
    kind: &str,
    flags: libc::c_ulong,
    data: &str,
) -> Result<()> {
    fs::create_dir_all(target)?;
    let (source, target, kind, data) = (
        CString::new(source)?,
        CString::new(target)?,
        CString::new(kind)?,
        CString::new(data)?,
    );
    if unsafe {
        libc::mount(
            source.as_ptr(),
            target.as_ptr(),
            kind.as_ptr(),
            flags,
            data.as_ptr().cast(),
        )
    } != 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}
pub(crate) fn run() -> Result<()> {
    // Root is read-only EROFS; only the independently identified v2 workspace may be formatted.
    mount(
        "proc",
        "/proc",
        "proc",
        libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC,
        "",
    )?;
    mount(
        "sysfs",
        "/sys",
        "sysfs",
        libc::MS_RDONLY | libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC,
        "",
    )?;
    mount("devtmpfs", "/dev", "devtmpfs", libc::MS_NOSUID, "mode=0755")?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    let root = CString::new("/")?;
    if unsafe { libc::statvfs(root.as_ptr(), &mut stat) } != 0 || stat.f_flag & libc::ST_RDONLY == 0
    {
        return Err("root must be read-only".into());
    }
    let launch = read_launch()?;
    mount(
        "tmpfs",
        "/tmp",
        "tmpfs",
        libc::MS_NOSUID | libc::MS_NODEV,
        "size=16777216,mode=1777",
    )?;
    mount(
        "tmpfs",
        "/run",
        "tmpfs",
        libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC,
        "size=1048576,mode=0755",
    )?;
    let result = match launch {
        BootLaunch::Legacy(launch) => {
            mount(
                "tmpfs",
                "/workspace",
                "tmpfs",
                libc::MS_NOSUID | libc::MS_NODEV,
                &format!(
                    "size={},uid=1000,gid=1000,mode=0700",
                    launch.workspace_bytes
                ),
            )?;
            runtime::probes(&launch)?;
            let control_listener = vsock_listener(1024)?;
            runtime::session(accept_host(control_listener)?, &launch)
        }
        BootLaunch::Workspace(launch) => {
            crate::workspace_boot::loopback()?;
            let proxy = std::net::TcpListener::bind("127.0.0.1:18080")?;
            let workspace = crate::workspace_boot::prepare(&launch)?;
            let probe_scope = crate::Launch {
                binding: launch.binding.clone(),
                manifest: launch.manifest.clone(),
                workspace_bytes: launch.workspace.bytes,
            };
            runtime::probes(&probe_scope)?;
            // Publish both transport listeners only after provisioning/probes,
            // so the peer's handshake deadline does not include mkfs latency.
            let data_listener = vsock_listener(1025)?;
            let control_listener = vsock_listener(1024)?;
            let ready = crate::data::Readiness::new();
            let state = ready.clone();
            let data_launch = launch.clone();
            let worker = std::thread::spawn(move || {
                let result = (|| -> Result<()> {
                    use std::os::fd::AsRawFd;
                    runtime::nonblock(data_listener.as_raw_fd())?;
                    let deadline = runtime::now() + 5000;
                    loop {
                        if state.stop.load(std::sync::atomic::Ordering::Acquire)
                            || runtime::now() >= deadline
                        {
                            return Err("data accept deadline".into());
                        }
                        let mut poll = libc::pollfd {
                            fd: data_listener.as_raw_fd(),
                            events: libc::POLLIN,
                            revents: 0,
                        };
                        if unsafe { libc::poll(&mut poll, 1, 10) } > 0 {
                            break;
                        }
                    }
                    let data = accept_host(data_listener)?;
                    crate::data::session(
                        data,
                        proxy,
                        &data_launch,
                        &state,
                        crate::file_executor::linux::start(workspace)?,
                    )
                })();
                if let Err(error) = result {
                    eprintln!("guest data closed: {error}");
                }
            });
            let control = accept_host(control_listener)?;
            let result = runtime::workspace_session(control, &launch, &ready);
            ready.stop.store(true, std::sync::atomic::Ordering::Release);
            let _ = worker.join();
            result
        }
    };
    // Remain PID1 and reap late orphans while the native supervisor fences the VM.
    eprintln!("guest session closed: {result:?}; native fence required");
    loop {
        let mut status = 0;
        unsafe {
            libc::waitpid(-1, &mut status, libc::WNOHANG);
        };
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

/// Kernel mountinfo and sysfs are mounted by PID1 above, never supplied by rootfs.
fn read_launch() -> Result<BootLaunch> {
    let device = launch_mount(&fs::read_to_string("/proc/self/mountinfo")?)?;
    let nonce = fs::read_to_string("/proc/cmdline")?
        .split_whitespace()
        .filter_map(|p| p.strip_prefix("canaveral.launch="))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if nonce.len() != 1 {
        return Err("trusted boot launch nonce required".into());
    }
    let serial = fs::read_to_string(format!("/sys/dev/block/{}/serial", device))?;
    let boot_attempt = uuid::Uuid::parse_str(&nonce[0])?;
    let expected_serial = boot_attempt.simple().to_string()[..20].to_owned();
    if serial.trim() != expected_serial {
        return Err("launch medium provenance mismatch".into());
    }
    let directory = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open("/etc/canaveral")?;
    let d = directory.metadata()?;
    if d.uid() != 0 || d.mode() & 0o777 != 0o700 {
        return Err("unsafe launch directory".into());
    }
    use std::os::fd::AsRawFd;
    let name = CString::new("launch.json")?;
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let file = unsafe { File::from_raw_fd(fd) };
    let m = file.metadata()?;
    if !m.is_file()
        || m.uid() != 0
        || m.mode() & 0o777 != 0o400
        || m.dev() != d.dev()
        || format!("{}:{}", libc::major(d.dev()), libc::minor(d.dev())) != device
        || m.len() > 16384
    {
        return Err("unsafe launch file".into());
    }
    let mut bytes = Vec::new();
    file.take(16385).read_to_end(&mut bytes)?;
    if bytes.len() > 16384 {
        return Err("launch config too large".into());
    }
    let launch = BootLaunch::parse(&bytes)?;
    if launch.binding().boot_attempt.to_string() != nonce[0] {
        return Err("boot nonce mismatch".into());
    }
    Ok(launch)
}

fn launch_mount(info: &str) -> Result<String> {
    let mut mounts = info.lines().filter_map(|line| {
        let (left, right) = line.split_once(" - ")?;
        Some((
            left.split_whitespace().collect::<Vec<_>>(),
            right.split_whitespace().collect::<Vec<_>>(),
        ))
    });
    let (entry, fsinfo) = mounts
        .find(|(v, _)| v.get(4) == Some(&"/etc/canaveral"))
        .ok_or("separate launch mount required")?;
    let root = info
        .lines()
        .find_map(|line| {
            let v: Vec<_> = line.split_whitespace().collect();
            (v.get(4) == Some(&"/")).then(|| v[2].to_owned())
        })
        .ok_or("missing root mount")?;
    if entry.len() < 6
        || fsinfo.len() < 3
        || entry[2] == root
        || entry[3] != "/"
        || fsinfo[0] != "erofs"
        || !["ro", "nosuid", "nodev", "noexec"]
            .iter()
            .all(|flag| entry[5].split(',').any(|f| f == *flag))
        || !fsinfo[2].split(',').any(|f| f == "ro")
    {
        return Err("invalid launch mount".into());
    }
    Ok(entry[2].to_owned())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn baked_and_untrusted_mounts_rejected() {
        let root = "1 0 253:0 / / ro - erofs /dev/vda ro\n";
        assert!(launch_mount(root).is_err());
        let good = format!(
            "{root}2 1 253:1 / /etc/canaveral ro,nosuid,nodev,noexec - erofs /dev/vdb ro\n"
        );
        assert_eq!(launch_mount(&good).unwrap(), "253:1");
        for bad in [
            good.replace("253:1", "253:0"),
            good.replace("noexec", "exec"),
            good.replace(" - erofs /dev/vdb", " - tmpfs tmpfs"),
            good.replace("253:1 / /etc", "253:1 /subdir /etc"),
        ] {
            assert!(launch_mount(&bad).is_err());
        }
    }
}

fn vsock_listener(port: u32) -> Result<File> {
    use std::os::fd::AsRawFd;
    let fd = unsafe { libc::socket(libc::AF_VSOCK, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let listener = unsafe { File::from_raw_fd(fd) };
    let mut address: libc::sockaddr_vm = unsafe { std::mem::zeroed() };
    address.svm_family = libc::AF_VSOCK as u16;
    address.svm_port = port;
    address.svm_cid = libc::VMADDR_CID_ANY;
    if unsafe {
        libc::bind(
            listener.as_raw_fd(),
            (&address as *const libc::sockaddr_vm).cast(),
            std::mem::size_of_val(&address) as u32,
        )
    } != 0
        || unsafe { libc::listen(fd, 1) } != 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(listener)
}
fn accept_host(listener: File) -> Result<File> {
    use std::os::fd::AsRawFd;
    let mut peer: libc::sockaddr_vm = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of_val(&peer) as libc::socklen_t;
    let fd = unsafe {
        libc::accept4(
            listener.as_raw_fd(),
            (&mut peer as *mut libc::sockaddr_vm).cast(),
            &mut len,
            libc::SOCK_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let stream = unsafe { File::from_raw_fd(fd) };
    // Consume the listener even on failure: no reconnect or second peer.
    drop(listener);
    if len as usize != std::mem::size_of_val(&peer)
        || peer.svm_family != libc::AF_VSOCK as u16
        || peer.svm_cid != libc::VMADDR_CID_HOST
    {
        return Err("vsock peer is not HOST_CID".into());
    }
    Ok(stream)
}
