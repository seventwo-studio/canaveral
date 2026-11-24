//! Libvirt FFI, process identity and Linux clocks.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::ffi::{c_char, c_int, c_uint, c_void, CStr, CString};
use std::fs;
use std::io::{self, BufRead, BufReader};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::thread;

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

type Ptr = *mut c_void;
const VIR_DOMAIN_START_PAUSED: c_uint = 1;
const VIR_DOMAIN_START_AUTODESTROY: c_uint = 2;
const VIR_DOMAIN_METADATA_ELEMENT: c_int = 2;
const VIR_DOMAIN_RUNNING: c_int = 1;
const VIR_DOMAIN_PAUSED: c_int = 3;
const VIR_ERR_NO_DOMAIN: c_int = 42;
const VIR_UUID_STRING_BUFLEN: usize = 37;
const OWNER_NAMESPACE: &CStr = c"urn:canaveral:libvirt:lease:1";
const METADATA_LIMIT: usize = 16384;

/// The libvirt client API, loaded at run time from the host's libvirt.so.0 and
/// libvirt-qemu.so.0. Building the helper needs no libvirt headers.
struct Libvirt {
    set_error_func: unsafe extern "C" fn(Ptr, Option<unsafe extern "C" fn(Ptr, Ptr)>),
    last_error_code: unsafe extern "C" fn() -> c_int,
    event_register_default: unsafe extern "C" fn() -> c_int,
    event_run_default: unsafe extern "C" fn() -> c_int,
    connect_open: unsafe extern "C" fn(*const c_char) -> Ptr,
    connect_close: unsafe extern "C" fn(Ptr) -> c_int,
    connect_register_close: unsafe extern "C" fn(
        Ptr,
        Option<unsafe extern "C" fn(Ptr, c_int, Ptr)>,
        Ptr,
        Option<unsafe extern "C" fn(Ptr)>,
    ) -> c_int,
    connect_keepalive: unsafe extern "C" fn(Ptr, c_int, c_uint) -> c_int,
    lookup_uuid: unsafe extern "C" fn(Ptr, *const c_char) -> Ptr,
    create_xml: unsafe extern "C" fn(Ptr, *const c_char, c_uint) -> Ptr,
    domain_free: unsafe extern "C" fn(Ptr) -> c_int,
    domain_resume: unsafe extern "C" fn(Ptr) -> c_int,
    domain_destroy: unsafe extern "C" fn(Ptr) -> c_int,
    domain_uuid: unsafe extern "C" fn(Ptr, *mut c_char) -> c_int,
    domain_persistent: unsafe extern "C" fn(Ptr) -> c_int,
    domain_active: unsafe extern "C" fn(Ptr) -> c_int,
    domain_state: unsafe extern "C" fn(Ptr, *mut c_int, *mut c_int, c_uint) -> c_int,
    domain_id: unsafe extern "C" fn(Ptr) -> c_uint,
    domain_metadata: unsafe extern "C" fn(Ptr, c_int, *const c_char, c_uint) -> *mut c_char,
    qemu_monitor: unsafe extern "C" fn(Ptr, *const c_char, *mut *mut c_char, c_uint) -> c_int,
}

fn open(name: &CStr) -> Result<Ptr> {
    let handle = unsafe { libc::dlopen(name.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
    if handle.is_null() {
        return Err(format!("{} is unavailable", name.to_string_lossy()).into());
    }
    Ok(handle)
}

/// # Safety
/// `T` must be the exact C function pointer type of `name`.
unsafe fn symbol<T: Copy>(handle: Ptr, name: &CStr) -> Result<T> {
    let address = unsafe { libc::dlsym(handle, name.as_ptr()) };
    if address.is_null() {
        return Err(format!("libvirt lacks {}", name.to_string_lossy()).into());
    }
    Ok(unsafe { std::mem::transmute_copy::<Ptr, T>(&address) })
}

fn libvirt() -> Result<&'static Libvirt> {
    static LIBRARY: OnceLock<std::result::Result<Libvirt, String>> = OnceLock::new();
    LIBRARY
        .get_or_init(|| load().map_err(|error| error.to_string()))
        .as_ref()
        .map_err(|error| error.clone().into())
}

fn load() -> Result<Libvirt> {
    let core = open(c"libvirt.so.0")?;
    let qemu = open(c"libvirt-qemu.so.0")?;
    // SAFETY: each type matches the libvirt C prototype of the named symbol.
    unsafe {
        Ok(Libvirt {
            set_error_func: symbol(core, c"virSetErrorFunc")?,
            last_error_code: symbol(core, c"virGetLastErrorCode")?,
            event_register_default: symbol(core, c"virEventRegisterDefaultImpl")?,
            event_run_default: symbol(core, c"virEventRunDefaultImpl")?,
            connect_open: symbol(core, c"virConnectOpen")?,
            connect_close: symbol(core, c"virConnectClose")?,
            connect_register_close: symbol(core, c"virConnectRegisterCloseCallback")?,
            connect_keepalive: symbol(core, c"virConnectSetKeepAlive")?,
            lookup_uuid: symbol(core, c"virDomainLookupByUUIDString")?,
            create_xml: symbol(core, c"virDomainCreateXML")?,
            domain_free: symbol(core, c"virDomainFree")?,
            domain_resume: symbol(core, c"virDomainResume")?,
            domain_destroy: symbol(core, c"virDomainDestroy")?,
            domain_uuid: symbol(core, c"virDomainGetUUIDString")?,
            domain_persistent: symbol(core, c"virDomainIsPersistent")?,
            domain_active: symbol(core, c"virDomainIsActive")?,
            domain_state: symbol(core, c"virDomainGetState")?,
            domain_id: symbol(core, c"virDomainGetID")?,
            domain_metadata: symbol(core, c"virDomainGetMetadata")?,
            qemu_monitor: symbol(qemu, c"virDomainQemuMonitorCommand")?,
        })
    }
}

unsafe extern "C" fn quiet(_: Ptr, _: Ptr) {}

static DISCONNECTED: AtomicBool = AtomicBool::new(false);

/// Close callback: libvirt reports connection loss, including a libvirtd restart.
unsafe extern "C" fn closed(_: Ptr, _: c_int, _: Ptr) {
    DISCONNECTED.store(true, Ordering::SeqCst);
}

/// Runs the libvirt default event loop on its own thread. It drives keepalive and the close
/// callback. Connection loss ends the process, which closes the connection even while the
/// command thread is blocked in an RPC.
pub fn events() -> Result<()> {
    let lib = libvirt()?;
    unsafe { (lib.set_error_func)(ptr::null_mut(), Some(quiet)) };
    if unsafe { (lib.event_register_default)() } != 0 {
        return Err("libvirt event initialization".into());
    }
    thread::spawn(move || loop {
        if unsafe { (lib.event_run_default)() } < 0 || DISCONNECTED.load(Ordering::SeqCst) {
            std::process::exit(1);
        }
    });
    Ok(())
}

/// The ownership the domain metadata must carry: per-launch UUID, nonce and lease.
pub struct Owner<'a> {
    pub uuid: &'a str,
    pub nonce: &'a str,
    pub lease: &'a str,
}

/// Checks the owner element libvirt returns for our namespace: one element named `owner`
/// whose machineId, bootId and leaseId attributes are exactly the expected values.
pub fn owner_metadata(xml: &str, owner: &Owner<'_>) -> bool {
    let xml = xml.trim();
    if xml.len() > METADATA_LIMIT || xml.contains("<!") || xml.contains("<?") {
        return false;
    }
    let Some(body) = xml.strip_prefix('<') else {
        return false;
    };
    let (body, closing) = if let Some(body) = body.strip_suffix("/>") {
        (body, None)
    } else if let Some(open) = body.find('>') {
        (&body[..open], Some(&body[open + 1..]))
    } else {
        return false;
    };
    let mut parts = body.split_ascii_whitespace();
    let tag = parts.next().unwrap_or_default();
    if tag.rsplit(':').next() != Some("owner") {
        return false;
    }
    if closing.is_some_and(|rest| rest.trim() != format!("</{tag}>")) {
        return false;
    }
    let mut seen = std::collections::BTreeMap::new();
    for attribute in body[tag.len()..].split('"').collect::<Vec<_>>().chunks(2) {
        let [name, value] = attribute else {
            if attribute.iter().all(|part| part.trim().is_empty()) {
                continue;
            }
            return false;
        };
        let Some(name) = name.trim().strip_suffix('=') else {
            return false;
        };
        if seen
            .insert(name.trim().to_string(), value.to_string())
            .is_some()
        {
            return false;
        }
    }
    [
        ("machineId", owner.uuid),
        ("bootId", owner.nonce),
        ("leaseId", owner.lease),
    ]
    .iter()
    .all(|(name, expected)| seen.get(*name).map(String::as_str) == Some(*expected))
}

pub struct Connection(Ptr);
pub struct Domain<'a>(Ptr, std::marker::PhantomData<&'a Connection>);

/// Only local system or session sockets, or an explicit mounted system socket.
pub fn local_uri(uri: &str) -> bool {
    matches!(uri, "qemu:///system" | "qemu:///session")
        || uri
            .strip_prefix("qemu+unix:///system?socket=")
            .is_some_and(|p| {
                p.starts_with('/')
                    && p.len() <= 107
                    && p[1..].split('/').all(|s| {
                        !s.is_empty()
                            && s != "."
                            && s != ".."
                            && s.bytes()
                                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
                    })
            })
}

impl Connection {
    /// A leased connection runs keepalive and registers the close callback.
    pub fn open(uri: &str, leased: bool) -> Result<Self> {
        if !local_uri(uri) {
            return Err("nonlocal libvirt URI".into());
        }
        let lib = libvirt()?;
        unsafe { (lib.set_error_func)(ptr::null_mut(), Some(quiet)) };
        let uri = CString::new(uri)?;
        let handle = unsafe { (lib.connect_open)(uri.as_ptr()) };
        if handle.is_null() {
            return Err("libvirt connection unavailable".into());
        }
        let connection = Self(handle);
        if leased
            && unsafe {
                (lib.connect_register_close)(handle, Some(closed), ptr::null_mut(), None) != 0
                    || (lib.connect_keepalive)(handle, 5, 3) != 0
            }
        {
            return Err("libvirt keepalive unavailable".into());
        }
        Ok(connection)
    }

    /// `None` only for the exact VIR_ERR_NO_DOMAIN reply.
    pub fn lookup(&self, uuid: &str) -> Result<Option<Domain<'_>>> {
        let lib = libvirt()?;
        let uuid = CString::new(uuid)?;
        let domain = unsafe { (lib.lookup_uuid)(self.0, uuid.as_ptr()) };
        if !domain.is_null() {
            return Ok(Some(Domain(domain, std::marker::PhantomData)));
        }
        if unsafe { (lib.last_error_code)() } == VIR_ERR_NO_DOMAIN {
            return Ok(None);
        }
        Err("libvirt lookup unconfirmed".into())
    }

    /// Transient and connection-bound: no definition survives the connection or a host restart.
    pub fn create(&self, xml: &str) -> Result<Domain<'_>> {
        let lib = libvirt()?;
        let xml = CString::new(xml)?;
        let flags = VIR_DOMAIN_START_PAUSED | VIR_DOMAIN_START_AUTODESTROY;
        let domain = unsafe { (lib.create_xml)(self.0, xml.as_ptr(), flags) };
        if domain.is_null() {
            return Err("paused transient create unconfirmed".into());
        }
        Ok(Domain(domain, std::marker::PhantomData))
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        if let Ok(lib) = libvirt() {
            unsafe { (lib.connect_close)(self.0) };
        }
    }
}

impl Drop for Domain<'_> {
    fn drop(&mut self) {
        if let Ok(lib) = libvirt() {
            unsafe { (lib.domain_free)(self.0) };
        }
    }
}

impl Domain<'_> {
    /// The domain ID and state (1 paused, 2 running, 3 other) of an owned, active transient domain.
    pub fn identity(&self, owner: &Owner<'_>) -> Result<(u32, i32)> {
        let lib = libvirt()?;
        let mut uuid = [0 as c_char; VIR_UUID_STRING_BUFLEN];
        let mut state = 0;
        let valid = unsafe {
            (lib.domain_uuid)(self.0, uuid.as_mut_ptr()) == 0
                && CStr::from_ptr(uuid.as_ptr()).to_bytes() == owner.uuid.as_bytes()
                && (lib.domain_persistent)(self.0) == 0
                && (lib.domain_active)(self.0) == 1
                && (lib.domain_state)(self.0, &mut state, ptr::null_mut(), 0) == 0
        };
        let id = unsafe { (lib.domain_id)(self.0) };
        if !valid || id == c_uint::MAX || id == 0 {
            return Err("transient domain identity differs".into());
        }
        let raw = unsafe {
            (lib.domain_metadata)(
                self.0,
                VIR_DOMAIN_METADATA_ELEMENT,
                OWNER_NAMESPACE.as_ptr(),
                0,
            )
        };
        if raw.is_null() {
            return Err("domain ownership metadata missing".into());
        }
        let metadata = unsafe { CStr::from_ptr(raw).to_string_lossy().into_owned() };
        unsafe { libc::free(raw.cast()) };
        if !owner_metadata(&metadata, owner) {
            return Err("domain ownership metadata differs".into());
        }
        Ok((
            id,
            match state {
                VIR_DOMAIN_PAUSED => 1,
                VIR_DOMAIN_RUNNING => 2,
                _ => 3,
            },
        ))
    }

    pub fn resume(&self) -> Result<()> {
        if unsafe { (libvirt()?.domain_resume)(self.0) } != 0 {
            return Err("resume unconfirmed".into());
        }
        Ok(())
    }

    pub fn destroy(&self) -> Result<()> {
        if unsafe { (libvirt()?.domain_destroy)(self.0) } != 0 {
            return Err("destroy unconfirmed".into());
        }
        Ok(())
    }

    /// The QEMU process birth from its QMP vCPU threads in the host PID namespace.
    pub fn birth(&self, uuid: &str) -> Result<Birth> {
        let lib = libvirt()?;
        let mut raw = ptr::null_mut();
        let command = c"{\"execute\":\"query-cpus-fast\"}";
        let status = unsafe { (lib.qemu_monitor)(self.0, command.as_ptr(), &mut raw, 0) };
        if status != 0 || raw.is_null() {
            unsafe { libc::free(raw.cast()) };
            return Err("QEMU thread query failed".into());
        }
        let parsed = unsafe { serde_json::from_slice::<Value>(CStr::from_ptr(raw).to_bytes()) };
        unsafe { libc::free(raw.cast()) };
        let parsed = parsed?;
        let threads = parsed["return"].as_array().ok_or("missing QEMU threads")?;
        let mut group = None;
        for thread in threads {
            let tid = thread["thread-id"]
                .as_u64()
                .filter(|v| *v > 1 && *v <= i32::MAX as u64)
                .ok_or("invalid QEMU thread")?;
            let status = fs::read_to_string(format!("/proc/{tid}/status"))?;
            let pid = status
                .lines()
                .find_map(|line| line.strip_prefix("Tgid:"))
                .ok_or("QEMU Tgid missing")?
                .trim()
                .parse::<i32>()?;
            if group.replace(pid).is_some_and(|previous| previous != pid) {
                return Err("ambiguous QEMU thread group".into());
            }
        }
        let pid = group.ok_or("empty QEMU thread group")?;
        let start = ticks(pid)?;
        let arguments = fs::read(format!("/proc/{pid}/cmdline"))?;
        let args: Vec<_> = arguments.split(|byte| *byte == 0).collect();
        if args
            .windows(2)
            .filter(|pair| pair[0] == b"-uuid" && pair[1] == uuid.as_bytes())
            .count()
            != 1
            || ticks(pid)? != start
        {
            return Err("QEMU process identity changed".into());
        }
        Ok(Birth { pid, start })
    }
}

/// A process identity: its PID and start time in clock ticks since boot.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Birth {
    pub pid: i32,
    pub start: u64,
}

pub fn ticks(pid: i32) -> io::Result<u64> {
    if pid <= 1 {
        return Err(io::Error::other("invalid process"));
    }
    let stat = fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let (_, fields) = stat
        .rsplit_once(") ")
        .ok_or_else(|| io::Error::other("invalid stat envelope"))?;
    fields
        .split_whitespace()
        .nth(19)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| io::Error::other("invalid start ticks"))
}

pub fn pidfd_ready(fd: &OwnedFd, timeout: i32) -> io::Result<bool> {
    let mut readiness = libc::pollfd {
        fd: fd.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    let status = unsafe { libc::poll(&mut readiness, 1, timeout) };
    if status < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(status > 0)
}

#[derive(Debug, PartialEq, Eq)]
pub enum Kill {
    /// The recorded process no longer exists.
    Gone,
    /// It still runs and was not signalled.
    Running,
    /// The kernel refused the signal, typically without CAP_KILL for QEMU's account.
    Denied,
}

impl Birth {
    #[cfg(test)]
    pub fn of(pid: i32) -> io::Result<Self> {
        Ok(Self {
            pid,
            start: ticks(pid)?,
        })
    }

    /// Pins the PID with a pidfd before rechecking its start time, so a reused PID is never
    /// signalled. With `kill`, sends SIGKILL through the pidfd and waits for the exit.
    pub fn fence(self, kill: bool) -> Result<Kill> {
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, self.pid, 0) } as i32;
        if fd < 0 {
            let error = io::Error::last_os_error();
            return if error.raw_os_error() == Some(libc::ESRCH) {
                Ok(Kill::Gone)
            } else {
                Err(error.into())
            };
        }
        let fd = unsafe { OwnedFd::from_raw_fd(fd) };
        match ticks(self.pid) {
            Ok(start) if start == self.start => {}
            Ok(_) => return Ok(Kill::Gone),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Kill::Gone),
            Err(error) => return Err(error.into()),
        }
        if pidfd_ready(&fd, 0)? {
            return Ok(Kill::Gone);
        }
        if !kill {
            return Ok(Kill::Running);
        }
        let status = unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                fd.as_raw_fd(),
                libc::SIGKILL,
                ptr::null::<libc::siginfo_t>(),
                0,
            )
        };
        if status != 0 {
            let error = io::Error::last_os_error();
            return match error.raw_os_error() {
                Some(libc::ESRCH) => Ok(Kill::Gone),
                Some(libc::EPERM) => Ok(Kill::Denied),
                _ => Err(error.into()),
            };
        }
        Ok(if pidfd_ready(&fd, 5000)? {
            Kill::Gone
        } else {
            Kill::Running
        })
    }
}

fn kata_cmdline(cmdline: &str) -> bool {
    cmdline.split_ascii_whitespace().any(|arg| {
        arg.starts_with("agent.")
            || matches!(arg, "init=/usr/bin/kata-agent" | "init=/sbin/kata-agent")
    })
}

fn kata_mount(line: &str) -> bool {
    let Some((mount, source)) = line.split_once(" - ") else {
        return false;
    };
    let mut source = source.split_ascii_whitespace();
    mount
        .split_ascii_whitespace()
        .nth(3)
        .is_some_and(|root| root.starts_with("/run/kata-containers/"))
        || matches!(
            (source.next(), source.next()),
            (Some("virtiofs" | "9p"), Some("kataShared"))
        )
}

fn gvisor_log(log: &[u8]) -> bool {
    log.split(|byte| *byte == b'\n')
        .any(|line| line.ends_with(b"] Starting gVisor..."))
}

/// Recognizes kernel-provided sandbox signals without executing a command or requiring privileges.
pub fn sandbox_kernel() -> bool {
    if fs::metadata("/proc/gvisor/kernel_is_gvisor").is_ok()
        || fs::read_to_string("/proc/cmdline").is_ok_and(|cmdline| kata_cmdline(&cmdline))
        || fs::File::open("/proc/self/mountinfo").is_ok_and(|mounts| {
            BufReader::new(mounts)
                .lines()
                .map_while(std::result::Result::ok)
                .any(|line| kata_mount(&line))
        })
    {
        return true;
    }
    // gVisor implements the unprivileged synthetic dmesg even without its optional proc marker.
    // SYSLOG_ACTION_READ_ALL reads without consuming the log. A restricted Linux log is normal.
    const READ_ALL: c_int = 3;
    let mut log = [0u8; 4096];
    let size = unsafe { libc::syscall(libc::SYS_syslog, READ_ALL, log.as_mut_ptr(), log.len()) };
    usize::try_from(size)
        .ok()
        .and_then(|size| log.get(..size))
        .is_some_and(gvisor_log)
}

pub fn boot_id() -> Result<String> {
    let raw = fs::read_to_string("/proc/sys/kernel/random/boot_id")?;
    let id = raw.trim();
    if id.len() != 36
        || !id.bytes().enumerate().all(|(i, byte)| match i {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => matches!(byte, b'0'..=b'9' | b'a'..=b'f'),
        })
    {
        return Err("invalid kernel boot identity".into());
    }
    Ok(id.to_owned())
}

/// Suspend-aware seconds since boot, the clock of every published deadline.
pub fn now() -> Result<f64> {
    let mut ts = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    if unsafe { libc::clock_gettime(libc::CLOCK_BOOTTIME, &mut ts) } != 0 {
        return Err(io::Error::last_os_error().into());
    }
    Ok(ts.tv_sec as f64 + ts.tv_nsec as f64 / 1e9)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinguishes_sandbox_kernel_signals_from_ordinary_linux() {
        assert!(gvisor_log(
            b"[    0.000000] Starting gVisor...\n[    1.000000] Ready\n"
        ));
        assert!(!gvisor_log(b"[    0.000000] Linux version 6.8.0\n"));
        assert!(kata_cmdline("root=/dev/vda agent.log=info"));
        assert!(kata_cmdline("init=/usr/bin/kata-agent"));
        assert!(!kata_cmdline(
            "root=/dev/vda systemd.unified_cgroup_hierarchy=1"
        ));
        assert!(kata_mount("12 1 0:8 /rootfs / rw - virtiofs kataShared rw"));
        assert!(kata_mount(
            "12 1 0:8 /run/kata-containers/sandbox/shm /dev/shm rw - tmpfs shm rw"
        ));
        assert!(!kata_mount("12 1 0:8 /rootfs / rw - overlay overlay rw"));
    }

    #[test]
    fn owner_metadata_requires_exact_identity_attributes() {
        let owner = Owner {
            uuid: "6d0f2f43-8f57-4a3d-9a8e-0d3c4e7b2a11",
            nonce: "0b7e6a5d-4c3b-4a29-8187-6f5e4d3c2b1a",
            lease: "1c9d5f88-2b3e-4d61-8a7f-5e4b3c2d1a00",
        };
        let element = |extra: &str| {
            format!(
                r#"<cv:owner xmlns:cv="urn:canaveral:libvirt:lease:1" version="1" machineId="{}" leaseId="{}" bootId="{}"{extra}/>"#,
                owner.uuid, owner.lease, owner.nonce
            )
        };
        assert!(owner_metadata(&element(""), &owner));
        assert!(owner_metadata(&element(" "), &owner));
        let open = element("").replace("/>", "></cv:owner>");
        assert!(owner_metadata(&open, &owner));
        for bad in [
            element("").replace(owner.nonce, "0b7e6a5d-4c3b-4a29-8187-6f5e4d3c2b1b"),
            element(r#" bootId="x""#),
            element("").replace("cv:owner", "cv:other"),
            element("").replace("/>", "><child/></cv:owner>"),
            format!("<!DOCTYPE x>{}", element("")),
            element("").replace(&format!(r#" leaseId="{}""#, owner.lease), ""),
        ] {
            assert!(!owner_metadata(&bad, &owner), "{bad}");
        }
    }

    #[test]
    fn local_uris_only() {
        assert!(local_uri("qemu:///system"));
        assert!(local_uri(
            "qemu+unix:///system?socket=/var/run/libvirt/libvirt-sock"
        ));
        for bad in [
            "qemu+ssh://host/system",
            "qemu+unix:///system?socket=/a/../b",
            "qemu:///system?x=1",
            "qemu+tcp://localhost/system",
        ] {
            assert!(!local_uri(bad));
        }
    }
}
