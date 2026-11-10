//! Minimal PID1 path. Pure parsing/planning is portable; mounts are Linux-only.
use canaveral_guest_protocol::Result;
pub fn base_args(s: &str) -> Result<()> {
    let tokens: Vec<_> = s.split_whitespace().collect();
    if s.is_empty()
        || s.len() > 2047
        || !s.bytes().all(|b| (32..=126).contains(&b))
        || s.contains(['\'', '"'])
        || tokens.contains(&"--")
        || tokens.contains(&"rw")
    {
        return Err("unsafe boot arguments".into());
    }
    for (prefix, expected) in [
        ("root=", "root=/dev/vda"),
        ("rootfstype=", "rootfstype=erofs"),
    ] {
        let values: Vec<_> = tokens.iter().filter(|t| t.starts_with(prefix)).collect();
        if values.len() != 1 || *values[0] != expected {
            return Err("unambiguous read-only EROFS /dev/vda root required".into());
        }
    }
    if tokens.iter().filter(|t| **t == "ro").count() != 1 {
        return Err("exactly one ro required".into());
    }
    Ok(())
}
pub fn launch(s: &str) -> Result<uuid::Uuid> {
    base_args(s.trim_end_matches('\n'))?;
    let values: Vec<_> = s
        .split_whitespace()
        .filter_map(|s| s.strip_prefix("canaveral.launch="))
        .collect();
    if values.len() != 1 {
        return Err("exactly one launch nonce required".into());
    }
    let id = uuid::Uuid::parse_str(values[0])?;
    if id.is_nil() || id.to_string() != values[0] {
        return Err("canonical nonnil launch nonce required".into());
    }
    Ok(id)
}
#[derive(Debug)]
pub struct Candidate {
    pub name: String,
    pub device: u64,
    pub partition: bool,
    pub serial: String,
    pub filesystem_uuid: uuid::Uuid,
}
pub fn select(id: uuid::Uuid, root: u64, devices: &[Candidate]) -> Result<&Candidate> {
    let serial = &id.simple().to_string()[..20];
    let matching: Vec<_> = devices
        .iter()
        .filter(|d| d.filesystem_uuid == id && d.serial == serial)
        .collect();
    if id.is_nil() || matching.len() != 1 || matching[0].partition || matching[0].device == root {
        return Err("unique separate whole launch device required".into());
    }
    Ok(matching[0])
}
pub fn run() -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        if unsafe { libc::getpid() } != 1 {
            return Err("bootstrap requires Linux PID1".into());
        }
        native::run()
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err("bootstrap requires Linux PID1".into())
    }
}
#[cfg(target_os = "linux")]
mod native {
    use super::*;
    use std::{
        ffi::CString,
        fs::{self, OpenOptions},
        io::Read,
        os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt},
        path::Path,
    };
    fn syscall(rc: i32) -> Result<()> {
        if rc != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }
    fn mount(source: &str, target: &str, kind: &str, flags: libc::c_ulong) -> Result<()> {
        let (s, t, k) = (
            CString::new(source)?,
            CString::new(target)?,
            CString::new(kind)?,
        );
        syscall(unsafe { libc::mount(s.as_ptr(), t.as_ptr(), k.as_ptr(), flags, std::ptr::null()) })
    }
    fn mountpoint(path: &str) -> Result<()> {
        let m = fs::symlink_metadata(path)?;
        if !m.is_dir() || m.uid() != 0 {
            return Err("trusted precreated mountpoint required".into());
        }
        Ok(())
    }
    fn bounded(path: impl AsRef<Path>, max: u64) -> Result<String> {
        let mut b = String::new();
        fs::File::open(path)?.take(max + 1).read_to_string(&mut b)?;
        if b.len() as u64 > max {
            return Err("kernel metadata exceeds bound".into());
        }
        Ok(b)
    }
    pub fn run() -> Result<()> {
        // Refuse host use before any privileged effect. No namespace bypass exists.
        if unsafe { libc::getpid() } != 1 || unsafe { libc::geteuid() } != 0 {
            return Err("root Linux PID1 required".into());
        }
        mount("", "/", "", libc::MS_REC | libc::MS_PRIVATE)?;
        for (kind, path) in [("proc", "/proc"), ("sysfs", "/sys"), ("devtmpfs", "/dev")] {
            mountpoint(path)?;
            mount(kind, path, kind, libc::MS_NOSUID | libc::MS_NOEXEC)?;
        }
        let id = launch(&bounded("/proc/cmdline", 2048)?)?;
        mountpoint("/newroot")?;
        let root = fs::symlink_metadata("/dev/vda")?;
        if !root.file_type().is_block_device() {
            return Err("root is not block device".into());
        }
        mount(
            "/dev/vda",
            "/newroot",
            "erofs",
            libc::MS_RDONLY | libc::MS_NOSUID | libc::MS_NODEV,
        )?;
        for p in [
            "/newroot/etc",
            "/newroot/etc/canaveral",
            "/newroot/proc",
            "/newroot/sys",
            "/newroot/dev",
        ] {
            mountpoint(p)?;
        }
        let mut chosen = None;
        for _ in 0..200 {
            let mut devices = Vec::new();
            for (count, e) in fs::read_dir("/sys/class/block")?.enumerate() {
                if count >= 256 {
                    return Err("block discovery bound exceeded".into());
                }
                let e = e?;
                let name = e
                    .file_name()
                    .into_string()
                    .map_err(|_| "invalid device name")?;
                if !name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                {
                    return Err("invalid block name".into());
                }
                let path = format!("/dev/{name}");
                let mut f = match OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
                    .open(&path)
                {
                    Ok(f) => f,
                    Err(_) => continue,
                };
                let m = f.metadata()?;
                if !m.file_type().is_block_device() {
                    return Err("block path substituted".into());
                }
                let dev = bounded(e.path().join("dev"), 64)?;
                if dev.trim() != format!("{}:{}", libc::major(m.rdev()), libc::minor(m.rdev())) {
                    return Err("sysfs device mismatch".into());
                }
                let serial = match bounded(e.path().join("serial"), 128) {
                    Ok(v) => v.trim().to_owned(),
                    Err(_) => continue,
                };
                let uuid = match crate::formats::erofs(&mut f) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                devices.push(Candidate {
                    name,
                    device: m.rdev(),
                    partition: e.path().join("partition").exists(),
                    serial,
                    filesystem_uuid: uuid,
                });
            }
            let matches = devices
                .iter()
                .filter(|d| d.filesystem_uuid == id && d.serial == id.simple().to_string()[..20])
                .count();
            if matches > 0 {
                let c = select(id, root.rdev(), &devices)?;
                chosen = Some((c.name.clone(), c.device));
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let (name, device) = chosen.ok_or("launch device discovery timed out")?;
        let path = format!("/dev/{name}");
        if fs::symlink_metadata(&path)?.rdev() != device {
            return Err("launch device changed".into());
        }
        mount(
            &path,
            "/newroot/etc/canaveral",
            "erofs",
            libc::MS_RDONLY | libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC,
        )?;
        let m = fs::metadata("/newroot/etc/canaveral")?;
        if m.uid() != 0 || m.mode() & 0o777 != 0o700 || m.dev() != device {
            return Err("unsafe launch filesystem root".into());
        }
        // Leave future proc/sys/dev unmounted: guest-agent owns their creation.
        // Unmount only our temporary mounts before moving the entire root tree;
        // MS_MOVE preserves the nested /etc/canaveral filesystem root mount.
        for path in ["/dev", "/sys", "/proc"] {
            let p = CString::new(path)?;
            syscall(unsafe { libc::umount2(p.as_ptr(), 0) })?;
        }
        std::env::set_current_dir("/newroot")?;
        mount(".", "/", "", libc::MS_MOVE)?;
        let dot = CString::new(".")?;
        syscall(unsafe { libc::chroot(dot.as_ptr()) })?;
        std::env::set_current_dir("/")?;
        let agent = CString::new("/sbin/canaveral-guest-agent")?;
        let args = [agent.as_ptr(), std::ptr::null()];
        let env = [std::ptr::null()];
        unsafe {
            libc::execve(agent.as_ptr(), args.as_ptr(), env.as_ptr());
        }
        Err(std::io::Error::last_os_error().into())
    }
}
