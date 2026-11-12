//! Linux PID1 workspace provisioning. No retry or recovery formatting path.
use crate::{
    boot::mount,
    runtime::now,
    workspace::{discover, Candidate},
};
use canaveral_guest_protocol::{bundle::WorkspaceLaunch, Result};
use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    os::{
        fd::AsRawFd,
        unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

fn mounted_device_uses(info: &str, block: &Path) -> Result<bool> {
    for line in info.lines() {
        let left = line.split_once(" - ").ok_or("invalid mountinfo")?.0;
        let fields: Vec<_> = left.split_whitespace().collect();
        let dev = fields.get(2).ok_or("invalid mountinfo device")?;
        let sys = Path::new("/sys/dev/block").join(dev);
        if sys.try_exists()? && fs::canonicalize(sys)?.starts_with(block) {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(crate) fn prepare(launch: &WorkspaceLaunch) -> Result<crate::workspace::confined::Root> {
    launch.validate()?;
    // Verify the pinned tool before any destructive action. mke2fs -V writes stderr.
    probe_mkfs(&launch.manifest.tool_versions["mkfsExt4"])?;
    let info = fs::read_to_string("/proc/self/mountinfo")?;
    let mut candidates = Vec::new();
    let mut devices = Vec::new();
    for entry in fs::read_dir("/sys/block")? {
        let entry = entry?;
        let sys = entry.path();
        let serial = match fs::read_to_string(sys.join("serial")) {
            Ok(s) => s.trim().to_owned(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
        };
        if serial != launch.workspace.serial {
            continue;
        }
        let sectors: u64 = fs::read_to_string(sys.join("size"))?.trim().parse()?;
        let bytes = sectors.checked_mul(512).ok_or("block size overflow")?;
        let block = fs::canonicalize(&sys)?;
        let mut partition = sys.join("partition").try_exists()?;
        for child in fs::read_dir(&sys)? {
            let child = child?;
            if child.file_type()?.is_dir() && child.path().join("partition").try_exists()? {
                partition = true;
            }
        }
        candidates.push(Candidate {
            serial,
            bytes,
            whole: !partition,
            signature: false,
            holders: fs::read_dir(sys.join("holders"))?
                .next()
                .transpose()?
                .is_some(),
            root_or_launch: mounted_device_uses(&info, &block)?,
        });
        devices.push((
            Path::new("/dev").join(entry.file_name()),
            fs::read_to_string(sys.join("dev"))?,
        ));
    }
    let index = discover(
        &candidates,
        &launch.workspace.serial,
        launch.workspace.bytes,
    )?;
    let (path, dev) = &devices[index];
    let mut disk = OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(path)?;
    let metadata = disk.metadata()?;
    if !metadata.file_type().is_block_device()
        || format!(
            "{}:{}",
            libc::major(metadata.rdev()),
            libc::minor(metadata.rdev())
        ) != dev.trim()
    {
        return Err("workspace device identity mismatch".into());
    }
    let mut size = 0u64;
    // BLKGETSIZE64, fixed Linux UAPI encoding on supported aarch64 guests.
    if unsafe { libc::ioctl(disk.as_raw_fd(), 0x80081272u32 as _, &mut size) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    if size != launch.workspace.bytes {
        return Err("workspace device size mismatch".into());
    }
    crate::workspace::require_blank(&mut disk, size)?;
    // The pinned PID1 descriptor, rather than a second /dev lookup, identifies
    // the only device passed to mkfs and mount. It remains open through both.
    let source = format!("/proc/{}/fd/{}", std::process::id(), disk.as_raw_fd());
    let mut child = Command::new("/usr/sbin/mkfs.ext4")
        .arg(&source)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    wait(&mut child, 120_000)?;
    mount(
        &source,
        "/workspace",
        "ext4",
        libc::MS_NOSUID | libc::MS_NODEV,
        "",
    )?;
    directory(Path::new("/workspace"))?;
    for name in [".canaveral", "home", "tmp", ".npm"] {
        let path = PathBuf::from("/workspace").join(name);
        fs::create_dir(&path)?;
        directory(&path)?;
    }
    let root = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open("/workspace")?;
    let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
    let mut options: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstatfs(root.as_raw_fd(), &mut stat) } != 0
        || unsafe { libc::fstatvfs(root.as_raw_fd(), &mut options) } != 0
        || stat.f_type != 0xef53
        || root.metadata()?.dev() != metadata.rdev()
        || options.f_flag & libc::ST_RDONLY != 0
        || options.f_flag & (libc::ST_NOSUID | libc::ST_NODEV) != libc::ST_NOSUID | libc::ST_NODEV
        || options.f_flag & libc::ST_NOEXEC != 0
    {
        return Err("workspace mount verification failed".into());
    }
    crate::workspace::confined::Root::new(root)
}
fn directory(path: &Path) -> Result<()> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    if unsafe { libc::fchown(file.as_raw_fd(), 1000, 1000) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    file.set_permissions(fs::Permissions::from_mode(0o700))?;
    let m = file.metadata()?;
    if m.uid() != 1000 || m.gid() != 1000 || m.mode() & 0o7777 != 0o700 {
        return Err("workspace directory ownership mismatch".into());
    }
    Ok(())
}
fn wait(child: &mut std::process::Child, timeout: u64) -> Result<()> {
    let start = now();
    loop {
        if let Some(status) = child.try_wait()? {
            return if status.success() {
                Ok(())
            } else {
                Err("mkfs.ext4 failed".into())
            };
        }
        if now().saturating_sub(start) >= timeout {
            child.kill()?;
            child.wait()?;
            return Err("mkfs.ext4 timed out; no retry permitted".into());
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn probe_mkfs(pin: &str) -> Result<()> {
    let mut child = Command::new("/usr/sbin/mkfs.ext4")
        .arg("-V")
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;
    // A bounded pipe cannot stall PID1: kill on timeout even if the tool fills it.
    wait(&mut child, 2000)?;
    let mut output = String::new();
    child
        .stderr
        .take()
        .ok_or("missing mkfs probe pipe")?
        .take(4097)
        .read_to_string(&mut output)?;
    if output.len() > 4096 || output.lines().next() != Some(pin) {
        return Err("mkfs.ext4 pin mismatch".into());
    }
    Ok(())
}

/// Configure only loopback; the guest has no NIC. Linux ifreq has a 16-byte
/// interface name followed by an alignment/padding union (40 bytes on aarch64).
pub(crate) fn loopback() -> Result<()> {
    use std::os::fd::FromRawFd;
    let fd = unsafe { libc::socket(libc::AF_INET, libc::SOCK_DGRAM | libc::SOCK_CLOEXEC, 0) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let socket = unsafe { File::from_raw_fd(fd) };
    let mut request: libc::ifreq = unsafe { std::mem::zeroed() };
    request.ifr_name[..2].copy_from_slice(&[b'l' as libc::c_char, b'o' as libc::c_char]);
    let address = libc::sockaddr_in {
        sin_family: libc::AF_INET as _,
        sin_port: 0,
        sin_addr: libc::in_addr {
            s_addr: u32::from_ne_bytes([127, 0, 0, 1]),
        },
        sin_zero: [0; 8],
    };
    unsafe {
        std::ptr::write(
            (&mut request.ifr_ifru.ifru_addr as *mut libc::sockaddr).cast::<libc::sockaddr_in>(),
            address,
        );
    }
    ioctl(socket.as_raw_fd(), libc::SIOCSIFADDR, &mut request)?;
    let mask = libc::sockaddr_in {
        sin_addr: libc::in_addr {
            s_addr: u32::from_ne_bytes([255, 0, 0, 0]),
        },
        ..address
    };
    unsafe {
        std::ptr::write(
            (&mut request.ifr_ifru.ifru_netmask as *mut libc::sockaddr).cast::<libc::sockaddr_in>(),
            mask,
        );
    }
    ioctl(socket.as_raw_fd(), libc::SIOCSIFNETMASK, &mut request)?;
    ioctl(socket.as_raw_fd(), libc::SIOCGIFFLAGS, &mut request)?;
    unsafe {
        request.ifr_ifru.ifru_flags |= (libc::IFF_UP | libc::IFF_RUNNING) as libc::c_short;
    }
    ioctl(socket.as_raw_fd(), libc::SIOCSIFFLAGS, &mut request)
}
fn ioctl(fd: i32, op: libc::c_ulong, request: &mut libc::ifreq) -> Result<()> {
    if unsafe { libc::ioctl(fd, op as _, request) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}
