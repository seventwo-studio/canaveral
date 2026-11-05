use crate::{runtime, Launch};
use canaveral_guest_protocol::Result;
use std::{
    ffi::CString,
    fs::{self, File},
    io::Read,
    os::fd::FromRawFd,
};
fn mount(source: &str, target: &str, kind: &str, flags: libc::c_ulong, data: &str) -> Result<()> {
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
    // Root is supplied as read-only EROFS; never remount or format a block device.
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
    let mut bytes = Vec::new();
    File::open("/etc/canaveral/launch.json")?
        .take(16385)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 16384 {
        return Err("launch config too large".into());
    }
    let launch: Launch = serde_json::from_slice(&bytes)?;
    launch.validate()?;
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
    let fd = unsafe { libc::socket(libc::AF_VSOCK, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let listener = unsafe { File::from_raw_fd(fd) };
    let mut address: libc::sockaddr_vm = unsafe { std::mem::zeroed() };
    address.svm_family = libc::AF_VSOCK as u16;
    address.svm_port = 1024;
    address.svm_cid = libc::VMADDR_CID_ANY;
    if unsafe {
        libc::bind(
            fd,
            (&address as *const libc::sockaddr_vm).cast(),
            std::mem::size_of_val(&address) as u32,
        )
    } != 0
        || unsafe { libc::listen(fd, 1) } != 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    // Exactly one accepted launch session. No accept loop or authority restoration.
    let mut peer: libc::sockaddr_vm = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of_val(&peer) as libc::socklen_t;
    let accepted = unsafe {
        libc::accept4(
            fd,
            (&mut peer as *mut libc::sockaddr_vm).cast(),
            &mut len,
            libc::SOCK_CLOEXEC,
        )
    };
    if accepted < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let stream = unsafe { File::from_raw_fd(accepted) };
    drop(listener);
    if len as usize != std::mem::size_of_val(&peer)
        || peer.svm_family != libc::AF_VSOCK as u16
        || peer.svm_cid != libc::VMADDR_CID_HOST
    {
        return Err("vsock peer is not HOST_CID".into());
    }
    let result = runtime::session(stream, &launch);
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
