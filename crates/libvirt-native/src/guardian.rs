//! The per-lease guardian, its connection worker and the proof-gated fence.
//!
//! The guardian holds the lease lock for its lifetime. Its worker owns the only libvirt
//! connection that creates the transient domain (PAUSED|AUTODESTROY) and dies with it
//! (PR_SET_PDEATHSIG). Daemon exit (pidfd), connection loss, a fenced or expired deadline and a
//! domain that stops all end the lease. The fence then destroys the domain through a fresh
//! connection only after ownership proof, and records `stopped` only after a fresh lookup
//! returns VIR_ERR_NO_DOMAIN. The daemon's reconciler runs the same fence after taking the lock.
use crate::journal::Journal;
use crate::native::{self, Birth, Connection, Kill, Owner, Result};
use crate::storage;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{self, BufRead, BufReader, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, TryRecvError};
use std::thread;
use std::time::Duration;

const SPEC: &str = "libvirt-native-spec.json";
const LAUNCH: &str = "libvirt-launch.json";
const AUTH: &str = "libvirt-authorization.json";
const RECEIPT: &str = "libvirt-native-execution.json";
const CREATE_RESULT: &str = "libvirt-native-create.json";
const REMOVAL: &str = "libvirt-native-removal.json";
const ERASED: &str = "libvirt-native-erased.json";
/// Linux UAPI asm-generic/socket.h; added in Linux 6.5.
const SO_PEERPIDFD: libc::c_int = 77;
/// `fence` or `erase` while a live guardian holds the lease lock (EX_TEMPFAIL).
pub const BUSY: i32 = 75;
/// The kernel cannot give a peer pidfd (EX_CONFIG).
pub const KERNEL: i32 = 78;
/// Seconds one fresh-connection probe may take before it counts as unconfirmed.
const PROBE_SECONDS: f64 = 10.0;

#[derive(Debug)]
pub struct Exit(pub i32);
impl std::fmt::Display for Exit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "exit {}", self.0)
    }
}
impl std::error::Error for Exit {}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Spec {
    uri: String,
    identity: Value,
    cluster: bool,
    xml: String,
}

fn id<'a>(value: &'a Value, name: &str) -> Result<&'a str> {
    let v = value[name].as_str().ok_or("missing identity")?;
    let valid = v.len() == 36
        && v.bytes().enumerate().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                c == b'-'
            } else {
                c.is_ascii_digit() || (b'a'..=b'f').contains(&c)
            }
        });
    if !valid {
        return Err("invalid identity".into());
    }
    Ok(v)
}

impl Spec {
    fn owner(&self) -> Result<Owner<'_>> {
        Ok(Owner {
            uuid: id(&self.identity, "machineId")?,
            nonce: id(&self.identity, "bootId")?,
            lease: id(&self.identity, "leaseId")?,
        })
    }
    fn host_boot(&self) -> Result<&str> {
        id(&self.identity, "hostBootId")
    }
}

fn read_spec(journal: &Journal) -> Result<Spec> {
    let spec: Spec = journal.read(SPEC)?.ok_or("missing native specification")?;
    spec.owner()?;
    spec.host_boot()?;
    if spec.xml.len() > 16384 || !native::local_uri(&spec.uri) {
        return Err("native specification exceeds its envelope".into());
    }
    Ok(spec)
}

#[derive(Clone, Copy, Deserialize, Serialize)]
struct Domain {
    id: u32,
    birth: Option<Birth>,
}

/// The guardian's durable receipt. `stopped` is written only after positive proof.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    identity: Value,
    /// unused | creating | paused | running | unknown | stopped
    phase: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    domain: Option<Domain>,
    #[serde(default)]
    stop_proven: bool,
    /// Why the lease ended; absent while it runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    /// The last unconfirmed fence condition, for operators.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fence: Option<String>,
}

impl Receipt {
    fn new(spec: &Spec, phase: &str) -> Self {
        Self {
            identity: spec.identity.clone(),
            phase: phase.into(),
            domain: None,
            stop_proven: false,
            reason: None,
            fence: None,
        }
    }
    fn load(journal: &Journal, spec: &Spec) -> Result<Self> {
        let receipt = journal
            .read::<Receipt>(RECEIPT)?
            .unwrap_or_else(|| Receipt::new(spec, "unused"));
        if receipt.identity != spec.identity {
            return Err("foreign launch receipt".into());
        }
        Ok(receipt)
    }
}

fn matches_identity(record: &Value, identity: &Value) -> bool {
    identity.as_object().is_some_and(|identity| {
        !identity.is_empty()
            && identity
                .iter()
                .all(|(key, expected)| record.get(key) == Some(expected))
    })
}

/// The daemon's pidfd from the inherited socket's peer, checked against its credentials.
fn pidfd_for_peer(socket: i32, parent: i32) -> Result<OwnedFd> {
    let mut credentials = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut size = std::mem::size_of_val(&credentials) as libc::socklen_t;
    let status = unsafe {
        libc::getsockopt(
            socket,
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut credentials as *mut libc::ucred).cast(),
            &mut size,
        )
    };
    if status != 0
        || size as usize != std::mem::size_of_val(&credentials)
        || credentials.pid != parent
        || credentials.uid != unsafe { libc::geteuid() }
    {
        return Err("daemon peer credentials differ".into());
    }
    let mut fd = -1i32;
    let mut size = std::mem::size_of_val(&fd) as libc::socklen_t;
    let status = unsafe {
        libc::getsockopt(
            socket,
            libc::SOL_SOCKET,
            SO_PEERPIDFD,
            (&mut fd as *mut i32).cast(),
            &mut size,
        )
    };
    if status != 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ENOPROTOOPT) {
            return Err(Box::new(Exit(KERNEL)));
        }
        return Err(error.into());
    }
    if fd < 0 || size as usize != std::mem::size_of_val(&fd) {
        return Err("invalid peer pidfd".into());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

#[derive(Default)]
struct Authority {
    revision: u64,
    deadline: Option<f64>,
}

impl Authority {
    /// Current, unfenced authority on this boot, from a live daemon. Returns why it ended.
    fn check(
        &mut self,
        journal: &Journal,
        spec: &Spec,
        daemon: &OwnedFd,
    ) -> std::result::Result<(), &'static str> {
        if native::pidfd_ready(daemon, 0).unwrap_or(true) {
            return Err("daemon-exited");
        }
        let same_boot = native::boot_id().ok().as_deref() == spec.host_boot().ok();
        if !same_boot {
            return Err("host-boot-changed");
        }
        let now = native::now().map_err(|_| "clock-unavailable")?;
        if self.deadline.is_some_and(|previous| now >= previous) {
            return Err("deadline");
        }
        let value: Value = match journal.read(AUTH) {
            Ok(Some(value)) => value,
            _ => return Err("authorization-unreadable"),
        };
        let revision = value["revision"].as_u64().filter(|r| *r > 0);
        let deadline = value["deadline"]
            .as_f64()
            .filter(|n| n.is_finite() && *n >= 0.0);
        let (Some(revision), Some(mut deadline)) = (revision, deadline) else {
            return Err("authorization-invalid");
        };
        if !matches_identity(&value, &spec.identity) || revision < self.revision {
            return Err("authorization-invalid");
        }
        if value["fenced"] != false {
            return Err("fenced");
        }
        // The same revision can never extend its deadline.
        if revision == self.revision {
            if let Some(previous) = self.deadline {
                deadline = deadline.min(previous);
            }
        }
        if now >= deadline {
            return Err("deadline");
        }
        self.revision = revision;
        self.deadline = Some(deadline);
        Ok(())
    }
}

/// A helper child that dies with this process (PR_SET_PDEATHSIG, armed before exec).
fn child(mode: &str, args: &[&str], stdin: Stdio) -> Result<Child> {
    let parent = unsafe { libc::getpid() };
    let mut command = Command::new("/proc/self/exe");
    command
        .arg(mode)
        .args(args)
        .stdin(stdin)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // This closure runs on the spawning (main) thread immediately before exec.
    unsafe {
        command.pre_exec(move || {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 || libc::getppid() != parent
            {
                return Err(io::Error::other("native guardian changed"));
            }
            Ok(())
        });
    }
    Ok(command.spawn()?)
}

fn tell(worker: &mut Child, command: &str) -> bool {
    worker
        .stdin
        .as_mut()
        .is_some_and(|input| writeln!(input, "{command}").is_ok())
}

fn stop(child: &mut Child) {
    if matches!(child.try_wait(), Ok(None)) {
        let _ = child.kill();
    }
    let _ = child.wait();
}

/// One fresh-connection proof, bounded in time. `destroy` may destroy a proven owned domain.
fn probe(folder: &Path, destroy: bool) -> bool {
    let Some(path) = folder.to_str() else {
        return false;
    };
    let mode = if destroy { "destroy" } else { "observe" };
    let Ok(mut probe) = child("probe", &[path, mode], Stdio::null()) else {
        return false;
    };
    let Ok(deadline) = native::now().map(|now| now + PROBE_SECONDS) else {
        stop(&mut probe);
        return false;
    };
    while native::now().is_ok_and(|now| now < deadline) {
        match probe.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) => thread::sleep(Duration::from_millis(25)),
            Err(_) => break,
        }
    }
    stop(&mut probe);
    false
}

/// Durable evidence published only by the connection worker after a successful create reply.
#[derive(Deserialize, Serialize)]
struct CreateResult {
    identity: Value,
    domain: Option<Domain>,
}

fn create_result(journal: &Journal, spec: &Spec) -> Result<Option<CreateResult>> {
    let result = journal.read::<CreateResult>(CREATE_RESULT)?;
    if result
        .as_ref()
        .is_some_and(|result| result.identity != spec.identity)
    {
        return Err("foreign create result".into());
    }
    Ok(result)
}

fn completed_create(receipt: &Receipt, result: Option<&CreateResult>, same_boot: bool) -> bool {
    !same_boot
        || receipt.stop_proven
        || receipt.phase == "unused"
        || receipt.domain.is_some()
        || result.is_some()
}

/// The ID and, on bare metal, the recorded QEMU birth are required before any destroy.
fn destruction_proof(domain: Option<Domain>, cluster: bool, same_boot: bool) -> Option<Domain> {
    domain.filter(|domain| {
        same_boot
            && domain.id > 0
            && domain.id < u32::MAX
            && (cluster
                || domain
                    .birth
                    .is_some_and(|birth| birth.pid > 1 && birth.start > 0))
    })
}

/// A lookup can prove absence only after the create completed or its host boot ended.
fn absent(journal: &Journal, spec: &Spec, receipt: &Receipt, destroy: bool) -> Result<bool> {
    let owner = spec.owner()?;
    let conn = Connection::open(&spec.uri, false)?;
    let same_boot = native::boot_id()? == spec.host_boot()?;
    let result = create_result(journal, spec)?;
    let domain = receipt
        .domain
        .or_else(|| result.as_ref().and_then(|result| result.domain));
    let birth = domain.and_then(|domain| domain.birth).filter(|_| same_boot);
    let qemu_gone = || -> Result<bool> {
        Ok(birth.map_or(Ok(Kill::Gone), |process| process.fence(false))? == Kill::Gone)
    };
    let Some(vm) = conn.lookup(owner.uuid)? else {
        return Ok(completed_create(receipt, result.as_ref(), same_boot) && qemu_gone()?);
    };
    if !destroy {
        return Ok(false);
    }
    let Some(expected) = destruction_proof(domain, spec.cluster, same_boot) else {
        return Ok(false);
    };
    // identity also checks the UUID, launch nonce and lease in the metadata.
    let (id, _) = vm.identity(&owner)?;
    if id != expected.id {
        return Err("live domain ID differs".into());
    }
    if let Some(process) = expected.birth {
        if vm.birth(owner.uuid)? != process {
            return Err("live QEMU birth differs".into());
        }
    }
    vm.destroy()?;
    drop(vm);
    if conn.lookup(owner.uuid)?.is_some() {
        return Ok(false);
    }
    qemu_gone()
}

/// Fences until a fresh lookup proves the domain gone or the budget ends. On bare metal it
/// also kills the recorded QEMU through a pidfd when libvirt cannot destroy it (needs CAP_KILL),
/// so an unavailable libvirtd cannot extend a guest past its fence.
fn fence(
    folder: &Path,
    journal: &Journal,
    spec: &Spec,
    receipt: &mut Receipt,
    budget: f64,
) -> Result<bool> {
    let deadline = native::now()? + budget;
    let mut killed = false;
    // Keep pre-submit evidence intact when the worker never received a create grant.
    if receipt.phase != "unused" {
        receipt.phase = "unknown".into();
    }
    receipt.fence = Some("libvirt-unconfirmed".into());
    journal.write(RECEIPT, receipt)?;
    loop {
        if probe(folder, true) {
            receipt.phase = "stopped".into();
            receipt.stop_proven = true;
            receipt.fence = None;
            journal.write(RECEIPT, receipt)?;
            return Ok(true);
        }
        let same_boot = native::boot_id()? == spec.host_boot()?;
        let result = create_result(journal, spec)?;
        let domain = receipt
            .domain
            .or_else(|| result.and_then(|result| result.domain));
        let birth =
            destruction_proof(domain, spec.cluster, same_boot).and_then(|domain| domain.birth);
        receipt.fence = Some(match (spec.cluster, same_boot, birth) {
            (false, true, Some(process)) if !killed => match process.fence(true) {
                Ok(Kill::Gone) => {
                    killed = true;
                    "qemu-killed-libvirt-unconfirmed".into()
                }
                Ok(Kill::Denied) => "qemu-kill-denied".into(),
                _ => "qemu-kill-unconfirmed".into(),
            },
            (false, true, Some(_)) => "qemu-killed-libvirt-unconfirmed".into(),
            _ => "libvirt-unconfirmed".into(),
        });
        journal.write(RECEIPT, receipt)?;
        if native::now()? >= deadline {
            return Ok(false);
        }
        thread::sleep(Duration::from_secs(1));
    }
}

#[derive(Deserialize)]
struct Reply {
    domain: Option<Domain>,
    running: Option<bool>,
    ended: Option<bool>,
}

/// Marks inherited descriptors (such as the helper image) close-on-exec for every child.
fn close_inherited() {
    for fd in 3..1024 {
        unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
    }
}

fn guard(folder: &Path, parent: i32) -> Result<()> {
    // Service stop signals reach the whole group; the guardian ends through the daemon's exit
    // and fences first.
    for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
        unsafe { libc::signal(signal, libc::SIG_IGN) };
    }
    close_inherited();
    if unsafe { libc::getppid() } != parent {
        return Err("daemon exited before guardian setup".into());
    }
    let daemon = pidfd_for_peer(0, parent)?;
    let journal = Journal::open(folder)?;
    let _lock = journal.lock()?.ok_or("lease lock is held")?;
    let spec = read_spec(&journal)?;
    let pid = std::process::id();
    let start = native::ticks(pid.try_into()?)?;
    let wait = native::now()? + 5.0;
    loop {
        if native::pidfd_ready(&daemon, 0)? || native::now()? >= wait {
            return Err("unconfirmed guardian launch".into());
        }
        if journal.read::<Value>(LAUNCH)?.is_some_and(|launch| {
            matches_identity(&launch, &spec.identity)
                && launch["parentPid"] == parent
                && launch["pid"] == pid
                && launch["createdAt"] == start
        }) {
            break;
        }
        thread::sleep(Duration::from_millis(25));
    }
    if journal.read::<Value>(RECEIPT)?.is_some() {
        return Err("native startup cannot be replayed".into());
    }
    let mut authority = Authority::default();
    authority.check(&journal, &spec, &daemon)?;
    let mut receipt = Receipt::new(&spec, "unused");
    journal.write(RECEIPT, &receipt)?;
    let path = folder.to_str().ok_or("invalid path")?;
    let mut worker = child("connection", &[path], Stdio::piped())?;
    let stdout = worker.stdout.take().ok_or("worker stdout unavailable")?;
    let (sender, replies) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let reply = line
                .ok()
                .and_then(|line| serde_json::from_str::<Reply>(&line).ok());
            if sender.send(reply).is_err() {
                break;
            }
        }
    });
    let reason: String = 'lease: {
        if let Err(reason) = authority.check(&journal, &spec, &daemon) {
            break 'lease reason.into();
        }
        receipt.phase = "creating".into();
        journal.write(RECEIPT, &receipt)?;
        if !tell(&mut worker, "create") {
            break 'lease "connection-ended".into();
        }
        loop {
            if let Err(reason) = authority.check(&journal, &spec, &daemon) {
                break 'lease reason.into();
            }
            match replies.try_recv() {
                Ok(Some(reply)) => {
                    if receipt.phase == "creating" && reply.domain.is_some() {
                        receipt.domain = reply.domain;
                        receipt.phase = "paused".into();
                        journal.write(RECEIPT, &receipt)?;
                        if let Err(reason) = authority.check(&journal, &spec, &daemon) {
                            break 'lease reason.into();
                        }
                        if !tell(&mut worker, "resume") {
                            break 'lease "connection-ended".into();
                        }
                    } else if receipt.phase == "paused" && reply.running == Some(true) {
                        receipt.phase = "running".into();
                        journal.write(RECEIPT, &receipt)?;
                    } else if reply.ended == Some(true) {
                        break 'lease "domain-ended".into();
                    } else {
                        break 'lease "invalid-worker-reply".into();
                    }
                }
                Ok(None) => break 'lease "invalid-worker-reply".into(),
                Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => {}
            }
            if !matches!(worker.try_wait(), Ok(None)) {
                break 'lease "connection-ended".into();
            }
            thread::sleep(Duration::from_millis(100));
        }
    };
    // Ending the worker closes its connection; AUTODESTROY then ends a domain that is still
    // bound to it. The fence below does not rely on that.
    stop(&mut worker);
    receipt.reason = Some(reason);
    journal.write(RECEIPT, &receipt)?;
    if fence(folder, &journal, &spec, &mut receipt, 30.0)? {
        Ok(())
    } else {
        Err("lease fence unconfirmed".into())
    }
}

/// The connection worker: the only libvirt connection that creates and resumes the domain.
fn connection(folder: &Path) -> Result<()> {
    let journal = Journal::open(folder)?;
    let spec = read_spec(&journal)?;
    let owner = spec.owner()?;
    let stdin = io::stdin();
    let mut commands = stdin.lock().lines();
    if commands.next().transpose()?.as_deref() != Some("create") {
        return Err("missing create grant".into());
    }
    native::events()?;
    let conn = Connection::open(&spec.uri, true)?;
    if conn.lookup(owner.uuid)?.is_some() {
        return Err("domain already exists".into());
    }
    let vm = conn.create(&spec.xml)?;
    let mut result = CreateResult {
        identity: spec.identity.clone(),
        domain: None,
    };
    journal.write(CREATE_RESULT, &result)?;
    let (id, state) = vm.identity(&owner)?;
    if state != 1 {
        return Err("domain is not paused".into());
    }
    let birth = if spec.cluster {
        None
    } else {
        Some(vm.birth(owner.uuid)?)
    };
    let domain = Domain { id, birth };
    result.domain = Some(domain);
    journal.write(CREATE_RESULT, &result)?;
    println!("{}", json!({"domain": domain}));
    if commands.next().transpose()?.as_deref() != Some("resume") {
        return Err("missing resume grant".into());
    }
    if vm.identity(&owner)? != (id, 1) {
        return Err("paused domain changed".into());
    }
    vm.resume()?;
    if vm.identity(&owner)? != (id, 2) {
        return Err("running domain changed".into());
    }
    println!("{}", json!({"running": true}));
    // A guest shutdown or crash ends the lease; the connection stays open until then.
    loop {
        thread::sleep(Duration::from_secs(2));
        if !matches!(vm.identity(&owner), Ok((current, 2)) if current == id) {
            println!("{}", json!({"ended": true}));
            return Err("leased domain stopped".into());
        }
    }
}

fn locked(journal: &Journal) -> Result<std::fs::File> {
    match journal.lock()? {
        Some(lock) => Ok(lock),
        None => {
            println!("busy");
            Err(Box::new(Exit(BUSY)))
        }
    }
}

pub fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match args.as_slice() {
        ["check"] => {
            let (ours, _peer) = UnixStream::pair()?;
            let fd = pidfd_for_peer(ours.as_raw_fd(), unsafe { libc::getpid() })?;
            if native::pidfd_ready(&fd, 0)? {
                return Err("invalid daemon pidfd".into());
            }
            println!("{}", native::now()?);
            Ok(())
        }
        ["clock"] => {
            println!("{}", native::now()?);
            Ok(())
        }
        ["guard", folder, parent] => guard(Path::new(folder), parent.parse()?),
        ["connection", folder] => connection(Path::new(folder)),
        ["probe", folder, mode @ ("observe" | "destroy")] => {
            let journal = Journal::open(Path::new(folder))?;
            let spec = read_spec(&journal)?;
            let receipt = Receipt::load(&journal, &spec)?;
            if absent(&journal, &spec, &receipt, *mode == "destroy")? {
                Ok(())
            } else {
                Err("domain absence unconfirmed".into())
            }
        }
        ["fence", folder] => {
            let path = Path::new(folder);
            let journal = Journal::open(path)?;
            let _lock = locked(&journal)?;
            let spec = read_spec(&journal)?;
            let mut receipt = Receipt::load(&journal, &spec)?;
            if receipt.phase != "stopped" || !receipt.stop_proven {
                receipt
                    .reason
                    .get_or_insert_with(|| "guardian-ended".into());
                if !fence(path, &journal, &spec, &mut receipt, 45.0)? {
                    return Err("lease fence unconfirmed".into());
                }
            }
            println!("stopped");
            Ok(())
        }
        ["erase", folder, target] => {
            let path = Path::new(folder);
            let journal = Journal::open(path)?;
            let _lock = locked(&journal)?;
            let spec = read_spec(&journal)?;
            let receipt = Receipt::load(&journal, &spec)?;
            // Erasure follows a positive stop and repeats the absence proof under the lock.
            if !(receipt.phase == "unused" || receipt.phase == "stopped" && receipt.stop_proven)
                || !probe(path, false)
            {
                return Err("owned domain stop unconfirmed".into());
            }
            let intent: storage::Intent = journal.read(REMOVAL)?.ok_or("missing removal intent")?;
            let previous: Option<storage::Erased> = journal.read(ERASED)?;
            storage::erase(&intent, Path::new(target), previous.as_ref(), |state| {
                journal.write(ERASED, state)
            })?;
            println!("erased");
            Ok(())
        }
        _ => Err("unsupported mode".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

    fn folder(name: &str) -> std::path::PathBuf {
        let path =
            std::env::temp_dir().join(format!("libvirt-native-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path
    }

    fn spec() -> Spec {
        let boot = native::boot_id().unwrap();
        Spec {
            uri: "qemu:///system".into(),
            identity: json!({"version": 1, "machineId": "6d0f2f43-8f57-4a3d-9a8e-0d3c4e7b2a11",
                "leaseId": "1c9d5f88-2b3e-4d61-8a7f-5e4b3c2d1a00", "bootId": "0b7e6a5d-4c3b-4a29-8187-6f5e4d3c2b1a",
                "hostBootId": boot}),
            cluster: false,
            xml: String::new(),
        }
    }

    fn own_pidfd() -> OwnedFd {
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, libc::getpid(), 0) } as i32;
        assert!(fd >= 0);
        unsafe { OwnedFd::from_raw_fd(fd) }
    }

    #[test]
    fn identities_and_uris_are_exact() {
        assert!(id(&json!({"a": "6d0f2f43-8f57-4a3d-9a8e-0d3c4e7b2a11"}), "a").is_ok());
        for bad in [
            "6D0F2F43-8F57-4A3D-9A8E-0D3C4E7B2A11",
            "6d0f2f43-8f57-4a3d-9a8e-0d3c4e7b2a1",
            "x",
        ] {
            assert!(id(&json!({ "a": bad }), "a").is_err());
        }
        assert!(native::local_uri("qemu:///system"));
        assert!(native::local_uri(
            "qemu+unix:///system?socket=/var/run/libvirt/libvirt-sock"
        ));
        for bad in [
            "qemu+ssh://host/system",
            "qemu+unix:///system?socket=/a/../b",
            "qemu:///system?x=1",
        ] {
            assert!(!native::local_uri(bad));
        }
    }

    #[test]
    fn uncertain_create_requires_a_successful_reply_or_new_boot() {
        let spec = spec();
        let result = CreateResult {
            identity: spec.identity.clone(),
            domain: None,
        };
        for phase in ["creating", "unknown", "create-failed", "stopped"] {
            let receipt = Receipt::new(&spec, phase);
            assert!(!completed_create(&receipt, None, true));
            assert!(completed_create(&receipt, Some(&result), true));
            assert!(completed_create(&receipt, None, false));
        }
        assert!(completed_create(&Receipt::new(&spec, "unused"), None, true));
    }

    #[test]
    fn a_live_domain_needs_durable_id_and_bare_metal_birth_to_destroy() {
        let without_birth = Some(Domain { id: 7, birth: None });
        assert!(destruction_proof(None, true, true).is_none());
        assert!(destruction_proof(without_birth, true, true).is_some());
        assert!(destruction_proof(without_birth, false, true).is_none());
        let with_birth = Some(Domain {
            id: 7,
            birth: Some(Birth { pid: 9, start: 10 }),
        });
        assert!(destruction_proof(with_birth, false, true).is_some());
        assert!(destruction_proof(with_birth, false, false).is_none());
        assert!(destruction_proof(
            Some(Domain {
                id: u32::MAX,
                birth: None
            }),
            true,
            true
        )
        .is_none());
    }

    #[test]
    fn authority_never_extends_and_ends_on_fence_or_expiry() {
        let path = folder("authority");
        let journal = Journal::open(&path).unwrap();
        let spec = spec();
        let daemon = own_pidfd();
        let publish = |revision: u64, deadline: f64, fenced: bool| {
            let mut value = spec.identity.clone();
            value["revision"] = json!(revision);
            value["deadline"] = json!(deadline);
            value["fenced"] = json!(fenced);
            journal.write(AUTH, &value).unwrap();
        };
        let now = native::now().unwrap();
        let mut authority = Authority::default();
        assert_eq!(
            authority.check(&journal, &spec, &daemon),
            Err("authorization-unreadable")
        );
        publish(1, now + 60.0, false);
        authority.check(&journal, &spec, &daemon).unwrap();
        // The same revision cannot extend its deadline; a lower revision is invalid.
        publish(1, now + 600.0, false);
        authority.check(&journal, &spec, &daemon).unwrap();
        assert!(authority.deadline.unwrap() <= now + 60.0);
        publish(2, now + 120.0, false);
        authority.check(&journal, &spec, &daemon).unwrap();
        publish(1, now + 120.0, false);
        assert_eq!(
            authority.check(&journal, &spec, &daemon),
            Err("authorization-invalid")
        );
        publish(3, now + 120.0, true);
        assert_eq!(authority.check(&journal, &spec, &daemon), Err("fenced"));
        let mut expired = Authority::default();
        publish(4, now - 1.0, false);
        assert_eq!(expired.check(&journal, &spec, &daemon), Err("deadline"));
        let mut foreign = Authority::default();
        let mut value = spec.identity.clone();
        value["bootId"] = json!("00000000-0000-4000-8000-000000000000");
        value["revision"] = json!(9);
        value["deadline"] = json!(now + 60.0);
        value["fenced"] = json!(false);
        journal.write(AUTH, &value).unwrap();
        assert_eq!(
            foreign.check(&journal, &spec, &daemon),
            Err("authorization-invalid")
        );
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn lease_lock_is_exclusive_and_records_are_private() {
        let path = folder("lock");
        let journal = Journal::open(&path).unwrap();
        let held = journal.lock().unwrap().expect("first lock");
        assert!(Journal::open(&path).unwrap().lock().unwrap().is_none());
        drop(held);
        assert!(journal.lock().unwrap().is_some());
        journal
            .write(RECEIPT, &json!({"phase": "stopped"}))
            .unwrap();
        std::fs::set_permissions(path.join(RECEIPT), std::fs::Permissions::from_mode(0o640))
            .unwrap();
        assert!(journal.read::<Value>(RECEIPT).is_err());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o750)).unwrap();
        assert!(Journal::open(&path).is_err());
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn exited_process_birth_is_gone_and_live_one_is_not_signalled() {
        let mut child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let birth = Birth::of(child.id() as i32).unwrap();
        assert_eq!(birth.fence(false).unwrap(), Kill::Running);
        // A different start time names another process: it is never signalled.
        let reused = Birth {
            pid: birth.pid,
            start: birth.start + 1,
        };
        assert_eq!(reused.fence(true).unwrap(), Kill::Gone);
        assert!(child.try_wait().unwrap().is_none());
        assert_eq!(birth.fence(true).unwrap(), Kill::Gone);
        child.wait().unwrap();
        assert_eq!(birth.fence(false).unwrap(), Kill::Gone);
    }

    #[test]
    fn peer_pidfd_comes_from_the_socket_creator() {
        let (ours, _peer) = UnixStream::pair().unwrap();
        let pid = unsafe { libc::getpid() };
        let fd = pidfd_for_peer(ours.as_raw_fd(), pid).unwrap();
        assert!(!native::pidfd_ready(&fd, 0).unwrap());
        assert!(pidfd_for_peer(ours.as_raw_fd(), pid + 1).is_err());
    }
}
