//! Independent deadline owner for one leased Android emulator or iOS simulator.
//!
//! The host publishes `lease-authorization.json` with an absolute deadline on this
//! boot's continuous clock. This process owns the emulator's dedicated process
//! group and stops it when that deadline passes, the authorization is fenced,
//! missing or changed, or this process is asked to terminate. It keeps running
//! when the host runner or controller is lost. Only a confirmed absent process
//! group produces `lease-stopped.json`; nothing else is a stop proof.
//!
//! The supervisor holds an exclusive `flock` on `lease-supervisor.lock` for its whole
//! life, so the host can prove it is gone without trusting a PID. It exits with
//! `REFUSED` only when it spawned nothing; every path after spawn stops the group first.
//!
//! A leased iOS simulator adds a second owned thing. The supervised child is then the
//! lease's own device-control companion, in its process group as above. The simulator
//! itself is booted and shut down through `simctl --set <device set>`: CoreSimulator
//! starts it through launchd, so it is never this process's child, and killing the
//! `simctl` client does not cancel what CoreSimulator began.
//!
//! Its stop is therefore proven only by positive evidence, held across a settling
//! period: CoreSimulator itself reports the device shut down, and the process table
//! shows none of the simulator's tree (see `simulator_tree`). Until both hold, this
//! process keeps its lock, keeps asking for the shutdown and keeps recording and
//! stopping tree members, so a boot that completes late is still shut down here. The
//! result is recorded as `treeAbsent` beside `groupAbsent`. A tree that was never
//! observed is reported as unproven. Native acceptance of that proof is open.
use crate::simulator_tree::{bounded, inventory, is_root, signal, Halt, Process, Tree};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::ffi::CString;
use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
static TERMINATE: AtomicBool = AtomicBool::new(false);
const AUTHORIZATION: &str = "lease-authorization.json";
const SUPERVISOR: &str = "lease-supervisor.json";
const FENCED: &str = "lease-fenced.json";
const STOPPED: &str = "lease-stopped.json";
const LOCK: &str = "lease-supervisor.lock";
/// Simulator tree members recorded while their parents were alive.
const TREE: &str = "lease-tree.json";
/// The private device set is always this directory of the assignment's storage.
const DEVICE_SET: &str = "device-set";
/// How long `simctl boot`, `simctl shutdown` and `simctl list` may run before their
/// group is killed.
const BOOT_LIMIT: Duration = Duration::from_secs(120);
const SHUTDOWN_LIMIT: Duration = Duration::from_secs(30);
const STATE_LIMIT: Duration = Duration::from_secs(15);
/// After a shutdown attempt, surviving tree members get this long before they are killed.
const TREE_GRACE: Duration = Duration::from_secs(5);
/// While CoreSimulator does not report the device shut down, the shutdown is asked again.
const SHUTDOWN_RETRY: Duration = Duration::from_secs(5);
/// A stop is proven only after the device stayed shut down and its tree stayed absent
/// for this long, in at least this many consecutive samples. A boot that CoreSimulator
/// received before its client was killed shows up within this period. The length is a
/// judgement, not a measurement: no real boot has been interrupted to time it.
const SETTLE: Duration = Duration::from_secs(5);
const SETTLE_SAMPLES: u32 = 5;
const SETTLE_INTERVAL: Duration = Duration::from_millis(500);
/// A boot that CoreSimulator accepted but whose `launchd_sim` never appears in the
/// process table within this window ends the lease: its stop could not be proven.
const START_WINDOW: Duration = Duration::from_secs(if cfg!(test) { 3 } else { 30 });
/// The sampling thread's interval, before and after the tree was first observed.
const FAST_SAMPLE_INTERVAL: Duration = Duration::from_millis(250);
const SAMPLE_INTERVAL: Duration = Duration::from_secs(2);
/// Inventories taken to stop every member before the kill, in one forced pass.
const FREEZE_PASSES: usize = 8;
/// Exit status that proves no emulator was spawned. Any other status is not that proof.
pub const REFUSED: i32 = 75;
/// The emulator log keeps at most this many bytes per launch.
const LOG_LIMIT: u64 = 16 << 20;

extern "C" fn terminate(_: libc::c_int) {
    TERMINATE.store(true, Ordering::SeqCst);
}

fn uuid(value: &Value, key: &str) -> Result<String> {
    let text = value[key].as_str().ok_or("Missing identity")?;
    let valid = text.len() == 36
        && text.char_indices().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == '-'
            } else {
                c.is_ascii_digit() || ('a'..='f').contains(&c)
            }
        });
    if !valid {
        return Err("Invalid identity".into());
    }
    Ok(text.to_owned())
}

/// Boot session identity, read the same way as the host's native lease clock.
pub fn boot_session() -> Result<String> {
    #[cfg(target_os = "linux")]
    let raw = std::fs::read_to_string("/proc/sys/kernel/random/boot_id")?;
    #[cfg(target_os = "macos")]
    let raw = {
        let name = CString::new("kern.bootsessionuuid")?;
        let mut buffer = [0u8; 64];
        let mut size = buffer.len();
        if unsafe {
            libc::sysctlbyname(
                name.as_ptr(),
                buffer.as_mut_ptr().cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        } != 0
        {
            return Err(io::Error::last_os_error().into());
        }
        String::from_utf8(
            buffer[..size]
                .iter()
                .copied()
                .take_while(|b| *b != 0)
                .collect(),
        )?
    };
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let raw: String = return Err("Boot session unsupported".into());
    let value = raw.trim().to_ascii_lowercase();
    uuid(&json!({ "id": value }), "id")?;
    if value == "00000000-0000-0000-0000-000000000000" {
        return Err("Invalid boot session".into());
    }
    Ok(value)
}

fn read_bounded(dir: &Path, name: &str) -> Result<Option<Value>> {
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(dir.join(name))
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let meta = file.metadata()?;
    if !meta.is_file() || meta.len() > 65536 {
        return Err("Expected a bounded regular record".into());
    }
    let mut data = Vec::new();
    file.take(65537).read_to_end(&mut data)?;
    if data.len() > 65536 {
        return Err("Record exceeds its envelope".into());
    }
    Ok(Some(serde_json::from_slice(&data)?))
}

fn save(dir: &Path, name: &str, value: &Value) -> Result<()> {
    let temporary = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    let _ = std::fs::remove_file(&temporary);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&temporary)?;
    file.write_all(serde_json::to_string(value)?.as_bytes())?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&temporary, dir.join(name))?;
    File::open(dir)?.sync_all()?;
    Ok(())
}

#[derive(Clone, Debug, PartialEq)]
pub struct Authorization {
    pub revision: u64,
    pub deadline: f64,
    pub fenced: bool,
}

/// The current owner's authorization; any mismatch is a fence, never a pause.
pub fn authorization(value: &Value, identity: &Value, session: &str) -> Result<Authorization> {
    if value["version"] != 1 {
        return Err("Unsupported authorization".into());
    }
    for key in ["machineId", "leaseId", "bootId"] {
        if uuid(value, key)? != uuid(identity, key)? {
            return Err("Authorization belongs to another assignment".into());
        }
    }
    if uuid(value, "bootSessionID")? != session {
        return Err("Authorization belongs to another boot".into());
    }
    let revision = value["revision"]
        .as_u64()
        .filter(|r| *r >= 1)
        .ok_or("Invalid revision")?;
    let deadline = value["deadline"]
        .as_f64()
        .filter(|d| d.is_finite() && *d >= 0.0)
        .ok_or("Invalid deadline")?;
    let fenced = value["fenced"].as_bool().ok_or("Invalid fence")?;
    Ok(Authorization {
        revision,
        deadline,
        fenced,
    })
}

/// Same or stale revisions never extend time; a renewal first seen after expiry is ignored.
pub fn advance(current: &Authorization, next: &Authorization, now: f64) -> Authorization {
    let fenced = current.fenced || next.fenced;
    if next.revision > current.revision && now < current.deadline {
        Authorization {
            revision: next.revision,
            deadline: next.deadline,
            fenced,
        }
    } else if next.revision == current.revision {
        Authorization {
            revision: current.revision,
            deadline: current.deadline.min(next.deadline),
            fenced,
        }
    } else {
        Authorization {
            fenced,
            ..current.clone()
        }
    }
}

fn private_directory(path: &str) -> Result<PathBuf> {
    let dir = PathBuf::from(path);
    let meta = std::fs::symlink_metadata(&dir)?;
    if !dir.is_absolute()
        || !meta.is_dir()
        || std::fs::canonicalize(&dir)? != dir
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
    {
        return Err("Supervisor storage must be a private real directory".into());
    }
    Ok(dir)
}

fn lock_file(dir: &Path, create: bool) -> io::Result<File> {
    // std opens with O_CLOEXEC, so the emulator never inherits the lock.
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    if create {
        options.write(true).create(true).mode(0o600);
    }
    let file = options.open(dir.join(LOCK))?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("Supervisor lock must be regular"));
    }
    Ok(file)
}

fn try_lock(file: &File) -> io::Result<bool> {
    loop {
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(true);
        }
        let error = io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::EINTR) => continue,
            Some(code) if code == libc::EWOULDBLOCK || code == libc::EAGAIN => return Ok(false),
            _ => return Err(error),
        }
    }
}

/// Whether a live supervisor holds this storage's lifetime lock. The kernel drops the
/// lock when the supervisor process ends, however it ends, so a free lock is positive
/// proof that no supervisor for this storage is running; PIDs are never consulted.
pub fn status(path: &str) -> Result<&'static str> {
    let dir = PathBuf::from(path);
    if !dir.is_absolute() {
        return Err("Supervisor storage must be absolute".into());
    }
    let file = match lock_file(&dir, false) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok("absent"),
        Err(error) => return Err(error.into()),
    };
    // A successful probe releases the lock when `file` closes on return.
    Ok(if try_lock(&file)? { "free" } else { "held" })
}

struct Group {
    child: Child,
    pgid: i32,
}
impl Group {
    fn exited(&self) -> Result<bool> {
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        if unsafe {
            libc::waitid(
                libc::P_PID,
                self.child.id() as libc::id_t,
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        } != 0
        {
            return Err(io::Error::last_os_error().into());
        }
        Ok(unsafe { info.assume_init().si_pid() } == self.child.id() as i32)
    }
    /// An error is "not yet exited": the stop loop keeps signalling rather than returning.
    fn exited_now(&self) -> bool {
        self.exited().unwrap_or(false)
    }
    fn absent(&self) -> bool {
        (unsafe { libc::kill(-self.pgid, 0) }) < 0
            && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }
    /// Infallible: it returns only after the leader is reaped and the whole group is
    /// absent. The leader stays an unreaped child until every signal is sent, so the
    /// PGID cannot be recycled. After reaping, the group is only observed.
    fn stop(&mut self, grace: Duration) -> i32 {
        if !self.exited_now() {
            unsafe { libc::kill(-self.pgid, libc::SIGTERM) };
            let deadline = Instant::now() + grace;
            while Instant::now() < deadline && !self.exited_now() {
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        loop {
            unsafe { libc::kill(-self.pgid, libc::SIGKILL) };
            if self.exited_now() {
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        let status = loop {
            match self.child.wait() {
                Ok(status) => break status.code().unwrap_or(-1),
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                // waitid already observed the exit; nothing else can reap our own child.
                Err(_) => break -1,
            }
        };
        // Never exit while a group member may survive: a supervisor that returns has
        // nothing it launched left in the group.
        while !self.absent() {
            std::thread::sleep(Duration::from_millis(20));
        }
        status
    }
}

/// One leased iOS simulator in the lease's private device set. It is never a child of
/// this process: `simctl` asks CoreSimulator to boot and shut it down. That it is shut
/// down is CoreSimulator's own statement about the device, and that nothing of it still
/// runs is read from the process table.
pub struct Simulator {
    tool: Vec<String>,
    set: String,
    udid: String,
    environment: Vec<(String, String)>,
    cwd: PathBuf,
    log: Option<File>,
    /// What the sampling thread last recorded. The supervision loop only reads it.
    sampled: Arc<Mutex<Sampled>>,
    /// Set when the stop begins: from then on only the stopping thread takes inventories.
    halted: Arc<AtomicBool>,
    inventory: fn() -> Result<Vec<Process>>,
    /// The exit status of `simctl boot`, when it returned one.
    boot: Option<i32>,
    /// CoreSimulator accepted the boot, or reported the device as anything but shut down.
    /// A process tree is then expected, and one that was never observed proves nothing.
    expected: bool,
}

struct Sampled {
    tree: Tree,
    /// Completed inventories.
    samples: u64,
    /// The device's own `launchd_sim` was in the last inventory.
    rooted: bool,
    /// The tree record could not be saved. It ends the lease.
    failed: bool,
}

/// What the simulator stop established.
struct TreeStop {
    /// The proof holds: CoreSimulator reported the device shut down (or gone), and no tree
    /// member was seen, continuously for the settling period, and either the tree was
    /// observed while it ran or nothing indicates that the device ever left `Shutdown`.
    absent: bool,
    observed: bool,
    forced: bool,
    shutdown: Option<i32>,
    device: String,
    settled: f64,
}

/// Records one inventory: every member present, and the tree record when it changed.
fn record(dir: &Path, identity: &Value, sampled: &mut Sampled, processes: &[Process]) {
    let (_, changed) = sampled.tree.observe(processes, None);
    sampled.samples += 1;
    sampled.rooted = processes
        .iter()
        .any(|p| !p.zombie && is_root(&p.command, &sampled.tree.device));
    if changed {
        let members: Vec<Value> = sampled
            .tree
            .seen
            .iter()
            .map(|(pid, started)| json!([pid, started]))
            .collect();
        let value = json!({"version": 1, "machineId": identity["machineId"], "leaseId": identity["leaseId"],
            "bootId": identity["bootId"], "members": members,
            "truncated": sampled.tree.truncated, "observed": sampled.tree.observed});
        sampled.failed |= save(dir, TREE, &value).is_err();
    }
}

impl Simulator {
    /// Validated before anything is spawned. The device set is always the storage's own
    /// `device-set` directory, so this process can never act on another device set.
    fn parse(value: &Value, dir: &Path, environment: &[(String, String)]) -> Result<Self> {
        let tool = value["tool"].as_array().ok_or("Missing simulator tool")?;
        let tool = tool
            .iter()
            .map(|part| part.as_str().map(str::to_owned).ok_or("Invalid tool"))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        if tool.is_empty()
            || tool.len() > 4
            || !Path::new(&tool[0]).is_absolute()
            || tool
                .iter()
                .any(|part| part.is_empty() || part.contains('\0') || part.len() > 4096)
        {
            return Err("Invalid simulator tool".into());
        }
        let set = value["deviceSet"].as_str().ok_or("Missing device set")?;
        let expected = dir.join(DEVICE_SET);
        if private_directory(set)? != expected {
            return Err("The device set must be this assignment's own".into());
        }
        let udid = value["udid"].as_str().ok_or("Missing simulator identity")?;
        let device = device_directory(set, udid)?;
        let log = OpenOptions::new()
            .append(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(dir.join("simulator.log"))
            .ok()
            .filter(|file| file.metadata().is_ok_and(|meta| meta.is_file()));
        Ok(Simulator {
            tool,
            set: set.to_owned(),
            udid: udid.to_owned(),
            environment: environment.to_vec(),
            cwd: dir.to_owned(),
            log,
            sampled: Arc::new(Mutex::new(Sampled {
                tree: Tree::new(&device),
                samples: 0,
                rooted: false,
                failed: false,
            })),
            halted: Arc::new(AtomicBool::new(false)),
            inventory,
            boot: None,
            expected: false,
        })
    }
    fn sampled(&self) -> MutexGuard<'_, Sampled> {
        self.sampled.lock().unwrap_or_else(PoisonError::into_inner)
    }
    /// Runs `simctl --set <set> <arguments>` in its own process group, never longer than
    /// `limit`, calling `check` while it waits. A stop reason or the limit kills that group.
    /// Killing it does not stop what CoreSimulator already began on its behalf.
    fn run(
        &self,
        arguments: &[&str],
        limit: Duration,
        capture: u64,
        check: impl FnMut() -> Option<&'static str>,
    ) -> std::result::Result<(Option<i32>, Vec<u8>), Halt> {
        let mut command = Command::new(&self.tool[0]);
        command
            .args(&self.tool[1..])
            .args(["--set", &self.set])
            .args(arguments)
            .env_clear()
            .envs(self.environment.iter().map(|(k, v)| (k, v)))
            .current_dir(&self.cwd);
        let log = || {
            self.log
                .as_ref()
                .and_then(|log| log.try_clone().ok())
                .map_or_else(Stdio::null, Stdio::from)
        };
        command.stderr(log());
        if capture == 0 {
            command.stdout(log());
        }
        bounded(command, limit, capture, check)
    }
    /// CoreSimulator's own state for this device in its own set: `Shutdown`, `Booting`,
    /// `Booted` and so on, or `absent` when the set no longer lists the device. `None`
    /// means CoreSimulator did not answer, which is never read as shut down.
    fn state(&self) -> Option<String> {
        let listing = self.run(&["list", "devices", "--json"], STATE_LIMIT, 4 << 20, || {
            None
        });
        let Ok((Some(0), data)) = listing else {
            return None;
        };
        let value: Value = serde_json::from_slice(&data).ok()?;
        let mut found: Option<String> = None;
        for entries in value["devices"].as_object()?.values() {
            for entry in entries.as_array()? {
                let same = entry["udid"]
                    .as_str()
                    .is_some_and(|udid| udid.eq_ignore_ascii_case(&self.udid));
                if same && found.replace(entry["state"].as_str()?.to_owned()).is_some() {
                    return None;
                }
            }
        }
        Some(found.unwrap_or_else(|| "absent".to_owned()))
    }
    /// Before the first boot the device must be shut down and nothing of it may run.
    fn idle(&self) -> bool {
        self.state().as_deref() == Some("Shutdown")
            && (self.inventory)()
                .is_ok_and(|processes| self.sampled().tree.alive(&processes, None).is_empty())
    }
    /// Starts the sampling thread. It takes the inventories, so the supervision loop never
    /// waits for one: a stalled inventory cannot delay a deadline, fence or signal check.
    /// Until the device's own `launchd_sim` has been seen it samples every 250 ms, then
    /// every 2 s. A thread that cannot be started only loses the samples before the stop.
    fn sample(&self, dir: &Path, identity: &Value) {
        let (dir, identity) = (dir.to_owned(), identity.clone());
        let (sampled, halted) = (Arc::clone(&self.sampled), Arc::clone(&self.halted));
        let inventory = self.inventory;
        let _ = std::thread::Builder::new().spawn(move || {
            while !halted.load(Ordering::SeqCst) {
                let mut pause = FAST_SAMPLE_INTERVAL;
                if let Ok(processes) = inventory() {
                    if halted.load(Ordering::SeqCst) {
                        break;
                    }
                    let mut sampled = sampled.lock().unwrap_or_else(PoisonError::into_inner);
                    record(&dir, &identity, &mut sampled, &processes);
                    if sampled.tree.observed {
                        pause = SAMPLE_INTERVAL;
                    }
                }
                let until = Instant::now() + pause;
                while Instant::now() < until && !halted.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        });
    }
    /// Asks CoreSimulator to boot the device, checking the deadline throughout. Returns the
    /// reason to stop, if the boot did not succeed. An interrupted boot may still complete:
    /// only the stop below establishes that it did not, or shuts it down when it does.
    fn boot(&mut self, check: impl FnMut() -> Option<&'static str>) -> Option<&'static str> {
        let udid = self.udid.clone();
        match self.run(&["boot", &udid], BOOT_LIMIT, 0, check) {
            Ok((Some(0), _)) => {
                self.boot = Some(0);
                self.expected = true;
                None
            }
            Ok((status, _)) => {
                self.boot = status;
                Some("boot")
            }
            Err(Halt::Reason(reason)) => Some(reason),
            Err(_) => Some("boot"),
        }
    }
    /// Stops every member before killing any, so none can start another process between an
    /// inventory and its signal: a stopped process cannot fork. It repeats until an inventory
    /// shows no member that is not already stopped, then kills them. Every signal is sent
    /// only after that PID's start time was re-read immediately before it.
    fn force(&self, dir: &Path, identity: &Value) {
        let mut frozen: BTreeMap<i32, String> = BTreeMap::new();
        for _ in 0..FREEZE_PASSES {
            let Ok(processes) = (self.inventory)() else {
                break;
            };
            let alive = {
                let mut sampled = self.sampled();
                record(dir, identity, &mut sampled, &processes);
                sampled.tree.alive(&processes, None)
            };
            let fresh: Vec<(i32, String)> = alive
                .into_iter()
                .filter(|(pid, started)| frozen.get(pid) != Some(started))
                .collect();
            if fresh.is_empty() {
                break;
            }
            for (pid, started) in fresh {
                if signal(pid, &started, libc::SIGSTOP) {
                    frozen.insert(pid, started);
                }
            }
        }
        for (pid, started) in &frozen {
            signal(*pid, started, libc::SIGKILL);
        }
    }
    /// Infallible, and it does not return on absence of evidence. It returns only after
    /// CoreSimulator has reported the device `Shutdown` (or gone from its set) and no tree
    /// member was seen, in every sample of a settling period. Until then it keeps asking
    /// CoreSimulator to shut the device down, keeps recording the members it sees, and kills
    /// those that outlive the grace. A boot that was interrupted, or that completes late, is
    /// therefore still shut down by this process, which holds its lock until then.
    fn stop(&mut self, dir: &Path, identity: &Value) -> TreeStop {
        self.halted.store(true, Ordering::SeqCst);
        let began = Instant::now();
        let (mut forced, mut shutdown) = (false, None);
        // When the shutdown was first asked, and when it was last asked. The grace before
        // members are killed runs from the first: a retry must never postpone the kill.
        let (mut asked, mut retried) = (None::<Instant>, None::<Instant>);
        let mut settled: Option<(Instant, u32)> = None;
        let udid = self.udid.clone();
        let device = loop {
            // First the inventory, so the last look happens while launchd_sim still parents
            // its tree. Members are recorded on every pass of the stop, not only before it.
            let alive = (self.inventory)().ok().map(|processes| {
                let mut sampled = self.sampled();
                record(dir, identity, &mut sampled, &processes);
                sampled.tree.alive(&processes, None)
            });
            let state = self.state();
            let down = matches!(state.as_deref(), Some("Shutdown" | "absent"));
            self.expected |= state.is_some() && !down;
            if !down && retried.is_none_or(|at| at.elapsed() >= SHUTDOWN_RETRY) {
                let result = self.run(&["shutdown", &udid], SHUTDOWN_LIMIT, 0, || None);
                shutdown = result.ok().and_then(|(status, _)| status);
                retried = Some(Instant::now());
                asked.get_or_insert(Instant::now());
            }
            let quiet = alive.as_ref().is_some_and(Vec::is_empty);
            if alive.is_some() && !quiet && asked.unwrap_or(began).elapsed() >= TREE_GRACE {
                forced = true;
                self.force(dir, identity);
            }
            // `down` and `quiet` were read before any shutdown or kill of this pass, so a
            // pass that had to act never counts towards the settling period.
            if down && quiet {
                let (since, samples) = settled.get_or_insert((Instant::now(), 0));
                *samples += 1;
                if since.elapsed() >= SETTLE && *samples >= SETTLE_SAMPLES {
                    break (state.unwrap_or_default(), since.elapsed().as_secs_f64());
                }
            } else {
                settled = None;
            }
            std::thread::sleep(SETTLE_INTERVAL);
        };
        let sampled = self.sampled();
        TreeStop {
            absent: !sampled.tree.truncated && (sampled.tree.observed || !self.expected),
            observed: sampled.tree.observed,
            forced,
            shutdown,
            device: device.0,
            settled: device.1,
        }
    }
}

/// The lease's own device directory. The identity is used exactly as CoreSimulator printed
/// it, because that is the directory name.
fn device_directory(set: &str, udid: &str) -> Result<String> {
    uuid(&json!({ "id": udid.to_ascii_lowercase() }), "id")?;
    Ok(format!("{set}/{udid}"))
}

/// What the process table shows of a leased simulator, for a host whose supervisor is
/// gone or whose receipt it re-checks. `tree` is `absent` when no member is present,
/// `present` when one is, and `unknown` when the record lost members. `observed` says
/// whether the device's own `launchd_sim` was ever seen: an absent tree that was never
/// observed is not evidence that a booted simulator stopped. One bounded inventory; it
/// never signals anything.
pub fn simulator_status(path: &str, set: &str, udid: &str) -> Result<Value> {
    let dir = PathBuf::from(path);
    if !dir.is_absolute() || Path::new(set) != dir.join(DEVICE_SET) {
        return Err("The device set must be this assignment's own".into());
    }
    let device = device_directory(set, udid)?;
    let (mut tree, mut truncated) = (Tree::new(&device), false);
    if let Some(record) = read_bounded(&dir, TREE)? {
        if record["version"] != 1 {
            return Err("Unsupported tree record".into());
        }
        truncated = record["truncated"] != false;
        tree.observed = record["observed"] == true;
        for member in record["members"].as_array().ok_or("Invalid tree record")? {
            let pid = member[0]
                .as_i64()
                .filter(|pid| *pid > 1 && *pid <= i32::MAX as i64)
                .ok_or("Invalid tree member")?;
            let started = member[1].as_str().ok_or("Invalid tree member")?;
            tree.seen.insert(pid as i32, started.to_owned());
        }
    }
    let processes = inventory()?;
    let alive = tree.alive(&processes, None);
    let observed = tree.observed
        || processes
            .iter()
            .any(|p| !p.zombie && is_root(&p.command, &device));
    let state = if truncated {
        "unknown"
    } else if alive.is_empty() {
        "absent"
    } else {
        "present"
    };
    Ok(json!({"version": 1, "tree": state, "observed": observed}))
}

/// Everything validated before anything is spawned. Holding it holds the lifetime lock.
pub struct Prepared {
    dir: PathBuf,
    identity: Value,
    session: String,
    current: Authorization,
    command: Command,
    log: File,
    started: f64,
    simulator: Option<Simulator>,
    _lock: File,
}

/// Validates one launch request and takes the storage's lifetime lock. Any error here
/// means nothing was spawned; the caller reports it with the dedicated `REFUSED` code.
pub fn prepare(path: &str, request: &Value, elapsed: fn() -> Result<f64>) -> Result<Prepared> {
    let dir = private_directory(path)?;
    if request["version"] != 1 {
        return Err("Unsupported launch request".into());
    }
    let identity = json!({
        "machineId": uuid(request, "machineId")?,
        "leaseId": uuid(request, "leaseId")?,
        "bootId": uuid(request, "bootId")?,
    });
    let lock = lock_file(&dir, true)?;
    // A runner's status probe holds the lock only for an instant; a live supervisor never lets go.
    let deadline = Instant::now() + Duration::from_secs(2);
    while !try_lock(&lock)? {
        if Instant::now() >= deadline {
            return Err("Another supervisor owns this assignment".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    for name in [SUPERVISOR, FENCED, STOPPED, TREE] {
        if std::fs::symlink_metadata(dir.join(name)).is_ok() {
            return Err("A supervised launch already used this assignment".into());
        }
    }
    let executable = request["executable"].as_str().ok_or("Missing executable")?;
    let cwd = request["cwd"].as_str().ok_or("Missing working directory")?;
    if !Path::new(executable).is_absolute() || !Path::new(cwd).is_absolute() {
        return Err("Launch paths must be absolute".into());
    }
    let args = request["args"].as_array().ok_or("Missing args")?;
    let env = request["env"].as_object().ok_or("Missing environment")?;
    if args.len() > 100 || env.len() > 256 {
        return Err("Launch request exceeds its envelope".into());
    }
    let session = boot_session()?;
    let current = authorization(
        &read_bounded(&dir, AUTHORIZATION)?.ok_or("Authorization is missing")?,
        &identity,
        &session,
    )?;
    // The only clock sample before spawn: nothing after spawn may fail early.
    let started = elapsed()?;
    if current.fenced || started >= current.deadline {
        return Err("Authorization has already ended".into());
    }
    let mut command = Command::new(executable);
    for arg in args {
        let arg = arg.as_str().ok_or("Invalid argument")?;
        if arg.contains('\0') || arg.len() > 16384 {
            return Err("Invalid argument".into());
        }
        command.arg(arg);
    }
    command.env_clear();
    let mut environment = Vec::with_capacity(env.len());
    for (key, value) in env {
        let value = value.as_str().ok_or("Invalid environment")?;
        if key.is_empty() || key.contains(['=', '\0']) || value.contains('\0') {
            return Err("Invalid environment".into());
        }
        command.env(key, value);
        environment.push((key.to_owned(), value.to_owned()));
    }
    command
        .current_dir(cwd)
        .stdin(Stdio::null())
        .process_group(0);
    let simulator = match request.get("simulator") {
        Some(value) => Some(Simulator::parse(value, &dir, &environment)?),
        None => None,
    };
    // The supervised child is the emulator, or a leased simulator's control companion.
    let log = OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(dir.join(if simulator.is_some() {
            "companion.log"
        } else {
            "emulator.log"
        }))?;
    if !log.metadata()?.is_file() {
        return Err("Emulator log must be regular".into());
    }
    Ok(Prepared {
        dir,
        identity,
        session,
        current,
        command,
        log,
        started,
        simulator,
        _lock: lock,
    })
}

/// Copies the emulator's output into its log up to `LOG_LIMIT`, then drains and drops it.
fn copy_capped(mut reader: io::PipeReader, mut log: File) {
    let mut written = log.metadata().map(|m| m.len()).unwrap_or(LOG_LIMIT);
    let mut buffer = [0u8; 16384];
    let mut truncated = false;
    loop {
        let count = match reader.read(&mut buffer) {
            Ok(0) => return,
            Ok(count) => count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return,
        };
        if written < LOG_LIMIT {
            let take = count.min((LOG_LIMIT - written) as usize);
            if log.write_all(&buffer[..take]).is_ok() {
                written += take as u64;
            }
        } else if !truncated {
            truncated = true;
            let _ = log.write_all(b"\n[canaveral: emulator log truncated at its size limit]\n");
        }
    }
}

/// Spawns the prepared emulator and owns it until the whole group is gone. Returns the
/// process exit code: `REFUSED` only when nothing was spawned, 0 after a written stop
/// receipt, 1 when the group was stopped but its receipt could not be written. Every
/// path after spawn ends in the infallible group stop.
pub fn run(prepared: Prepared, elapsed: fn() -> Result<f64>, announce: impl FnOnce(&Value)) -> i32 {
    let Prepared {
        dir,
        identity,
        session,
        current,
        mut command,
        log,
        started,
        mut simulator,
        _lock,
    } = prepared;
    if TERMINATE.load(Ordering::SeqCst) {
        return REFUSED;
    }
    // A device that CoreSimulator does not report as shut down, or that already has
    // processes, was not left by this launch: refuse it. This also refuses a host whose
    // CoreSimulator does not answer, which could never prove a stop later.
    if simulator.as_ref().is_some_and(|sim| !sim.idle()) {
        return REFUSED;
    }
    let Ok((reader, writer)) = io::pipe() else {
        return REFUSED;
    };
    let Ok(stderr) = writer.try_clone() else {
        return REFUSED;
    };
    let child = match command.stdout(writer).stderr(stderr).spawn() {
        Ok(child) => child,
        // std reaps a child whose exec failed before returning the error.
        Err(_) => return REFUSED,
    };
    // Drop the parent's pipe writers so the copier ends with the group.
    drop(command);
    // Thread creation can fail after the child exists; a failed copier must not skip the group stop,
    // so it only loses the log (the reader is dropped and the child sees a closed pipe on write).
    let _ = std::thread::Builder::new().spawn(move || copy_capped(reader, log));
    let pid = child.id();
    let mut group = Group {
        child,
        pgid: pid as i32,
    };
    let mut record = json!({
        "version": 1, "machineId": identity["machineId"], "leaseId": identity["leaseId"],
        "bootId": identity["bootId"], "bootSessionID": session,
        "supervisorPid": std::process::id(), "childPid": pid, "startedAt": started,
    });
    if let Some(sim) = &simulator {
        record["simulator"] = json!({"deviceSet": sim.set, "udid": sim.udid});
    }
    let mut state = Watch {
        dir: &dir,
        identity: &identity,
        session: &session,
        current,
        elapsed,
    };
    let reason = match save(&dir, SUPERVISOR, &record) {
        Ok(()) => {
            announce(&json!({"supervisorPid": std::process::id(), "childPid": pid}));
            // The simulator boots only after the record exists, so a host that lost this
            // process always finds the device set it has to prove stopped. Sampling starts
            // before the boot, so a tree that appears during a slow boot is recorded.
            match simulator.as_mut() {
                Some(sim) => {
                    sim.sample(&dir, &identity);
                    match sim.boot(|| state.check(&group)) {
                        Some(reason) => reason,
                        None => watch(&mut state, &group, Some(sim)),
                    }
                }
                None => watch(&mut state, &group, None),
            }
        }
        Err(_) => "record",
    };
    // An emulator that exited on its own needs no fence. A simulator is still shut down
    // below, which takes time, so its fence is always published first.
    if reason != "exited" || simulator.is_some() {
        // A failed sticky marker must never prevent stopping the group.
        let _ = save(
            &dir,
            FENCED,
            &json!({"version": 1, "machineId": identity["machineId"], "leaseId": identity["leaseId"],
                "bootId": identity["bootId"], "reason": reason}),
        );
    }
    let status = group.stop(Duration::from_secs(5));
    let mut receipt = json!({"version": 1, "machineId": identity["machineId"], "leaseId": identity["leaseId"],
        "bootId": identity["bootId"], "bootSessionID": session, "reason": reason,
        "supervisorPid": std::process::id(), "childPid": pid, "groupAbsent": true, "exitStatus": status});
    if let Some(sim) = simulator.as_mut() {
        // Never exits while the device may still boot or a member of its tree may survive.
        let stopped = sim.stop(&dir, &identity);
        receipt["simulator"] = json!({"deviceSet": sim.set, "udid": sim.udid});
        receipt["deviceState"] = json!(stopped.device);
        receipt["settledSeconds"] = json!(stopped.settled);
        receipt["treeAbsent"] = json!(stopped.absent);
        receipt["treeObserved"] = json!(stopped.observed);
        receipt["treeForced"] = json!(stopped.forced);
        receipt["bootStatus"] = json!(sim.boot);
        receipt["shutdownStatus"] = json!(stopped.shutdown);
    }
    // The lifetime lock is released only after the receipt, when `_lock` drops.
    if save(&dir, STOPPED, &receipt).is_ok() {
        0
    } else {
        1
    }
}

/// `lease-supervise <dir>` with one JSON launch request on stdin. Returns the exit code.
pub fn supervise(path: &str, elapsed: fn() -> Result<f64>) -> i32 {
    let read = || -> Result<Value> {
        let mut line = Vec::new();
        io::stdin()
            .lock()
            .take(1_048_577)
            .read_until(b'\n', &mut line)?;
        if line.len() > 1_048_576 || line.last() != Some(&b'\n') {
            return Err("Launch request exceeds its envelope".into());
        }
        Ok(serde_json::from_slice(&line)?)
    };
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
        libc::signal(libc::SIGHUP, libc::SIG_IGN);
        libc::signal(libc::SIGTERM, terminate as *const () as libc::sighandler_t);
        libc::signal(libc::SIGINT, terminate as *const () as libc::sighandler_t);
    }
    let prepared = match read().and_then(|request| prepare(path, &request, elapsed)) {
        Ok(prepared) => prepared,
        Err(_) => return REFUSED,
    };
    run(prepared, elapsed, |line| {
        // The host reads this one line; afterwards nothing is written to its pipe.
        let mut out = io::stdout().lock();
        let _ = writeln!(out, "{line}");
        let _ = out.flush();
        drop(out);
        if let Ok(null) = CString::new("/dev/null") {
            let fd = unsafe { libc::open(null.as_ptr(), libc::O_RDWR) };
            if fd >= 0 {
                unsafe {
                    libc::dup2(fd, 0);
                    libc::dup2(fd, 1);
                    libc::dup2(fd, 2);
                    libc::close(fd);
                }
            }
        }
    })
}

/// The authorization this process enforces, re-read on every supervision tick.
struct Watch<'a> {
    dir: &'a Path,
    identity: &'a Value,
    session: &'a str,
    current: Authorization,
    elapsed: fn() -> Result<f64>,
}

impl Watch<'_> {
    /// One tick: the reason to stop now, if any.
    fn check(&mut self, group: &Group) -> Option<&'static str> {
        match group.exited() {
            Ok(true) => return Some("exited"),
            Ok(false) => {}
            Err(_) => return Some("process"),
        }
        if TERMINATE.load(Ordering::SeqCst) {
            return Some("signal");
        }
        let Ok(now) = (self.elapsed)() else {
            return Some("clock");
        };
        let next = match read_bounded(self.dir, AUTHORIZATION) {
            Ok(Some(value)) => match authorization(&value, self.identity, self.session) {
                Ok(next) => next,
                Err(_) => return Some("authorization"),
            },
            _ => return Some("authorization"),
        };
        self.current = advance(&self.current, &next, now);
        if self.current.fenced {
            return Some("fenced");
        }
        if now >= self.current.deadline {
            return Some("expired");
        }
        None
    }
}

fn watch(state: &mut Watch, group: &Group, simulator: Option<&Simulator>) -> &'static str {
    let booted = Instant::now();
    let baseline = simulator.map(|sim| sim.sampled().samples);
    loop {
        std::thread::sleep(Duration::from_millis(100));
        if let Some(reason) = state.check(group) {
            return reason;
        }
        let Some(sim) = simulator else {
            continue;
        };
        // This only reads what the sampling thread last recorded. The inventory itself runs
        // on that thread, so a slow or stalled one never delays the check above.
        let sampled = sim.sampled();
        if sampled.failed {
            return "record";
        }
        if Some(sampled.samples) == baseline {
            continue;
        }
        if sampled.tree.observed {
            // The device's own launchd_sim is gone: the simulator stopped by itself.
            if !sampled.rooted {
                return "exited";
            }
        } else if booted.elapsed() >= START_WINDOW {
            // CoreSimulator accepted the boot, yet its launchd_sim never appeared in the
            // process table. The stop of such a simulator cannot be proven, so the lease ends.
            return "unobserved";
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    fn auth(revision: u64, deadline: f64, fenced: bool) -> Authorization {
        Authorization {
            revision,
            deadline,
            fenced,
        }
    }
    #[test]
    fn renewal_needs_a_newer_revision_before_expiry() {
        let current = auth(2, 100.0, false);
        assert_eq!(
            advance(&current, &auth(3, 200.0, false), 50.0).deadline,
            200.0
        );
        assert_eq!(
            advance(&current, &auth(2, 200.0, false), 50.0).deadline,
            100.0
        );
        assert_eq!(
            advance(&current, &auth(2, 80.0, false), 50.0).deadline,
            80.0
        );
        assert_eq!(
            advance(&current, &auth(1, 300.0, false), 50.0).deadline,
            100.0
        );
        assert_eq!(
            advance(&current, &auth(3, 300.0, false), 100.0).deadline,
            100.0
        );
        assert!(advance(&current, &auth(1, 300.0, true), 50.0).fenced);
        assert!(advance(&auth(2, 100.0, true), &auth(3, 300.0, false), 50.0).fenced);
    }
    #[test]
    fn authorization_binds_assignment_and_boot() {
        let identity = json!({"machineId": "11111111-1111-4111-8111-111111111111", "leaseId": "22222222-2222-4222-8222-222222222222", "bootId": "33333333-3333-4333-8333-333333333333"});
        let session = "44444444-4444-4444-8444-444444444444";
        let mut value = identity.clone();
        value["version"] = json!(1);
        value["bootSessionID"] = json!(session);
        value["revision"] = json!(1);
        value["deadline"] = json!(10.5);
        value["fenced"] = json!(false);
        assert_eq!(
            authorization(&value, &identity, session).unwrap(),
            auth(1, 10.5, false)
        );
        assert!(authorization(&value, &identity, "55555555-5555-4555-8555-555555555555").is_err());
        let mut other = value.clone();
        other["leaseId"] = json!("66666666-6666-4666-8666-666666666666");
        assert!(authorization(&other, &identity, session).is_err());
        other = value.clone();
        other["deadline"] = json!(-1.0);
        assert!(authorization(&other, &identity, session).is_err());
    }
    #[test]
    fn boot_session_is_a_uuid() {
        assert_eq!(boot_session().unwrap().len(), 36);
    }

    // Test clocks: a fixed origin, and one that fails on every call after the first.
    fn clock() -> Result<f64> {
        Ok(1000.0)
    }
    static FAILING_CALLS: AtomicUsize = AtomicUsize::new(0);
    fn failing_clock() -> Result<f64> {
        if FAILING_CALLS.fetch_add(1, Ordering::SeqCst) == 0 {
            Ok(1000.0)
        } else {
            Err("clock lost".into())
        }
    }
    fn storage(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lease-supervisor-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::os::unix::fs::PermissionsExt::from_mode(0o700))
            .unwrap();
        std::fs::canonicalize(dir).unwrap()
    }
    fn request(dir: &Path, deadline: f64, fenced: bool) -> Value {
        let identity = json!({"machineId": "11111111-1111-4111-8111-111111111111", "leaseId": "22222222-2222-4222-8222-222222222222", "bootId": "33333333-3333-4333-8333-333333333333"});
        let mut value = identity.clone();
        value["version"] = json!(1);
        value["bootSessionID"] = json!(boot_session().unwrap());
        value["revision"] = json!(1);
        value["deadline"] = json!(deadline);
        value["fenced"] = json!(fenced);
        save(dir, AUTHORIZATION, &value).unwrap();
        let mut launch = identity;
        launch["version"] = json!(1);
        launch["executable"] = json!("/bin/sh");
        launch["args"] = json!(["-c", "sleep 30 & sleep 30"]);
        launch["env"] = json!({});
        launch["cwd"] = json!(dir.to_str().unwrap());
        launch
    }
    fn group_alive(pgid: i32) -> bool {
        unsafe { libc::kill(-pgid, 0) == 0 }
    }

    #[test]
    fn a_clock_failure_after_spawn_still_stops_the_whole_group() {
        let dir = storage("clock");
        let launch = request(&dir, 5000.0, false);
        let prepared = prepare(dir.to_str().unwrap(), &launch, failing_clock).unwrap();
        let mut spawned = None;
        let code = run(prepared, failing_clock, |line| {
            spawned = line["childPid"].as_i64();
        });
        let pid = spawned.expect("the emulator was spawned") as i32;
        assert_eq!(code, 0);
        assert!(!group_alive(pid));
        let stopped = read_bounded(&dir, STOPPED).unwrap().unwrap();
        assert_eq!(stopped["reason"], "clock");
        assert_eq!(stopped["groupAbsent"], true);
        assert_eq!(
            read_bounded(&dir, FENCED).unwrap().unwrap()["reason"],
            "clock"
        );
        assert_eq!(status(dir.to_str().unwrap()).unwrap(), "free");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn ended_authorization_is_refused_before_anything_spawns() {
        let dir = storage("refused");
        for (deadline, fenced) in [(999.0, false), (5000.0, true)] {
            let launch = request(&dir, deadline, fenced);
            assert!(prepare(dir.to_str().unwrap(), &launch, clock).is_err());
            assert!(!dir.join(SUPERVISOR).exists());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_lifetime_lock_is_held_until_the_stop_receipt_and_excludes_a_second_supervisor() {
        let dir = storage("lock");
        let path = dir.to_str().unwrap().to_owned();
        assert_eq!(status(&path).unwrap(), "absent");
        let launch = request(&dir, 5000.0, false);
        let prepared = prepare(&path, &launch, clock).unwrap();
        assert_eq!(status(&path).unwrap(), "held");
        let worker = std::thread::spawn(move || run(prepared, clock, |_| {}));
        while !dir.join(SUPERVISOR).exists() {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(status(&path).unwrap(), "held");
        // A second supervisor for the same storage is refused while the first lives.
        assert!(prepare(&path, &launch, clock).is_err());
        request(&dir, 5000.0, true);
        assert_eq!(worker.join().unwrap(), 0);
        assert!(dir.join(STOPPED).exists());
        assert_eq!(status(&path).unwrap(), "free");
        // Even with the lock free, a used assignment is never launched again.
        request(&dir, 5000.0, false);
        assert!(prepare(&path, &launch, clock).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    // A stand-in CoreSimulator for one device. `simctl list` reports the device's state,
    // `boot` starts a stand-in `launchd_sim` that is named and argued like the real one,
    // with one child that names nothing, and `shutdown` stops it. Neither process is a
    // child of the supervisor. Like CoreSimulator, `list` reports a device whose
    // launchd_sim is gone as shut down, and `shutdown` fails for a device that is not booted.
    const UDID: &str = "5A0E2F31-5B7C-4D8E-9F01-23456789ABCD";
    const BOOT: &str = r#""$dir/launchd_sim" "$set/$udid/data/launchd_bootstrap.plist" >/dev/null 2>&1 & echo $! > "$pid"; echo Booted > "$state""#;
    // The client blocks, as it does while CoreSimulator boots; the test plays the service.
    const BLOCKED_BOOT: &str = r#"echo requested > "$set/$udid.requested"; sleep 600"#;
    // A simulator whose processes do not name their device: the premise does not hold.
    const UNNAMED_BOOT: &str =
        r#""$dir/quiet_sim" >/dev/null 2>&1 & echo $! > "$pid"; echo Booted > "$state""#;
    const GRACEFUL: &str = r#"running || exit 1; p=$(cat "$pid"); kill -TERM "$p"; while kill -0 "$p" 2>/dev/null; do sleep 0.1; done; echo Shutdown > "$state""#;
    struct Stand {
        dir: PathBuf,
        set: PathBuf,
        path: String,
        launch: Value,
    }
    impl Stand {
        fn set(&self) -> &str {
            self.set.to_str().unwrap()
        }
        fn device(&self) -> PathBuf {
            self.set.join(UDID)
        }
        fn state(&self, state: &str) {
            let temporary = self.set.join(format!("{UDID}.state.tmp"));
            std::fs::write(&temporary, format!("{state}\n")).unwrap();
            std::fs::rename(temporary, self.set.join(format!("{UDID}.state"))).unwrap();
        }
        fn stopped(&self) -> Value {
            read_bounded(&self.dir, STOPPED).unwrap().unwrap()
        }
        fn status(&self) -> Value {
            simulator_status(&self.path, self.set(), UDID).unwrap()
        }
        /// Plays CoreSimulator completing a boot: the device's launchd_sim appears, started
        /// by this process and not by the supervisor or its `simctl` client.
        fn appear(&self) -> i32 {
            let mut root = Command::new(self.dir.join("launchd_sim"))
                .arg(self.device().join("data/launchd_bootstrap.plist"))
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let pid = root.id() as i32;
            std::fs::write(self.set.join(format!("{UDID}.pid")), pid.to_string()).unwrap();
            // Collected as soon as it exits, as launchd collects a real launchd_sim.
            std::thread::spawn(move || root.wait());
            self.state("Booted");
            pid
        }
        fn remove(self) {
            std::fs::remove_dir_all(self.dir).unwrap();
        }
    }
    fn simulated(name: &str, boot: &str, shutdown: &str) -> Stand {
        let dir = storage(name);
        let set = dir.join(DEVICE_SET);
        std::fs::create_dir_all(set.join(UDID).join("data")).unwrap();
        let mode = std::os::unix::fs::PermissionsExt::from_mode;
        std::fs::set_permissions(&set, mode(0o700)).unwrap();
        let script = |name: &str, body: String| {
            std::fs::write(dir.join(name), body).unwrap();
            std::fs::set_permissions(dir.join(name), mode(0o755)).unwrap();
        };
        script(
            "launchd_sim",
            "#!/bin/sh\ntrap 'kill $child; exit 0' TERM\nsleep 300 & child=$!\necho $child > \"$1.child\"\nwait\n".into(),
        );
        script(
            "quiet_sim",
            "#!/bin/sh\ntrap 'kill $child; exit 0' TERM\nsleep 300 & child=$!\nwait\n".into(),
        );
        script(
            "simctl",
            format!(
                r#"#!/bin/sh
dir='{dir}'; set="$2"; verb="$3"; udid={UDID}; state="$set/$udid.state"; pid="$set/$udid.pid"
running() {{ [ -s "$pid" ] && kill -0 "$(cat "$pid")" 2>/dev/null; }}
case "$verb" in
  list)
    s=$(cat "$state")
    if [ "$s" = Booted ] && ! running; then s=Shutdown; fi
    printf '{{"devices":{{"com.apple.CoreSimulator.SimRuntime.iOS-27-0":[{{"udid":"%s","state":"%s"}}]}}}}' "$udid" "$s" ;;
  boot) {boot} ;;
  shutdown) {shutdown} ;;
  *) exit 2 ;;
esac
"#,
                dir = dir.to_str().unwrap()
            ),
        );
        let mut launch = request(&dir, 5000.0, false);
        launch["simulator"] = json!({"tool": [dir.join("simctl").to_str().unwrap()], "deviceSet": set.to_str().unwrap(), "udid": UDID});
        let stand = Stand {
            path: dir.to_str().unwrap().to_owned(),
            dir,
            set,
            launch,
        };
        stand.state("Shutdown");
        stand
    }
    fn until(what: &str, seconds: u64, mut done: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(seconds);
        while !done() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    fn number(path: PathBuf) -> i32 {
        let mut value = None;
        until("a recorded process", 10, || {
            value = std::fs::read_to_string(&path)
                .ok()
                .and_then(|text| text.trim().parse().ok());
            value.is_some()
        });
        value.unwrap()
    }
    fn process_alive(pid: i32) -> bool {
        inventory()
            .unwrap()
            .iter()
            .any(|p| p.pid == pid && !p.zombie)
    }
    /// A process that only mentions the device, as an operator's `tail` or a shell would.
    /// It waits on its own input, so it has no child and keeps its command line.
    fn mention(stand: &Stand) -> std::process::Child {
        Command::new("/bin/sh")
            .args(["-c", "read line; :"])
            .arg(stand.device().join("data/system.log"))
            .stdin(Stdio::piped())
            .spawn()
            .unwrap()
    }
    /// Boots under the real supervisor loop and returns the stand-in root and its child,
    /// once the tree record holds both.
    fn booted(
        stand: &Stand,
        announced: std::sync::mpsc::Sender<i64>,
    ) -> (std::thread::JoinHandle<i32>, i32, i32) {
        let prepared = prepare(&stand.path, &stand.launch, clock).unwrap();
        let worker = std::thread::spawn(move || {
            run(prepared, clock, |line| {
                let _ = announced.send(line["childPid"].as_i64().unwrap());
            })
        });
        let root = number(stand.set.join(format!("{UDID}.pid")));
        let child = number(stand.device().join("data/launchd_bootstrap.plist.child"));
        until("the recorded tree", 10, || {
            read_bounded(&stand.dir, TREE).is_ok_and(|tree| {
                tree.is_some_and(|tree| {
                    tree["observed"] == true
                        && tree["members"].as_array().is_some_and(|m| m.len() == 2)
                })
            })
        });
        (worker, root, child)
    }

    #[test]
    fn a_leased_simulator_is_booted_then_shut_down_and_its_stop_rests_on_settled_evidence() {
        let stand = simulated("simulator", BOOT, GRACEFUL);
        assert_eq!(
            stand.status(),
            json!({"version": 1, "tree": "absent", "observed": false})
        );
        let mut bystander = mention(&stand);
        let (sender, receiver) = std::sync::mpsc::channel();
        let (worker, root, child) = booted(&stand, sender);
        let companion = receiver.recv().unwrap() as i32;
        assert!(process_alive(root) && process_alive(child) && group_alive(companion));
        let record = read_bounded(&stand.dir, SUPERVISOR).unwrap().unwrap();
        assert_eq!(record["simulator"]["udid"], UDID);
        assert_eq!(record["childPid"], companion);
        assert_eq!(
            stand.status(),
            json!({"version": 1, "tree": "present", "observed": true})
        );
        assert_eq!(status(&stand.path).unwrap(), "held");
        // The fence: the companion's group and the simulator's tree both stop.
        let fenced = Instant::now();
        request(&stand.dir, 5000.0, true);
        assert_eq!(worker.join().unwrap(), 0);
        let stopped = stand.stopped();
        assert_eq!(stopped["reason"], "fenced");
        assert_eq!(stopped["groupAbsent"], true);
        assert_eq!(stopped["treeAbsent"], true);
        assert_eq!(stopped["treeObserved"], true);
        assert_eq!(stopped["treeForced"], false);
        assert_eq!(stopped["deviceState"], "Shutdown");
        assert_eq!(stopped["bootStatus"], 0);
        assert_eq!(stopped["shutdownStatus"], 0);
        assert_eq!(stopped["simulator"]["deviceSet"], stand.set());
        // The receipt waited for the device to stay shut down, not for one empty inventory.
        assert!(stopped["settledSeconds"].as_f64().unwrap() >= SETTLE.as_secs_f64());
        assert!(fenced.elapsed() >= SETTLE);
        assert!(!process_alive(root) && !process_alive(child) && !group_alive(companion));
        assert_eq!(status(&stand.path).unwrap(), "free");
        assert_eq!(
            stand.status(),
            json!({"version": 1, "tree": "absent", "observed": true})
        );
        // A process that only mentioned the device was never a member and never signalled.
        assert!(bystander.try_wait().unwrap().is_none());
        bystander.kill().unwrap();
        bystander.wait().unwrap();
        // A used assignment is never booted again.
        request(&stand.dir, 5000.0, false);
        assert!(prepare(&stand.path, &stand.launch, clock).is_err());
        stand.remove();
    }

    #[test]
    fn a_tree_member_that_outlives_the_simulator_is_still_found_and_stopped() {
        // The shutdown kills only the root: its child is reparented and names nothing.
        let stand = simulated(
            "orphan",
            BOOT,
            r#"kill -KILL "$(cat "$pid")"; echo Shutdown > "$state""#,
        );
        let (sender, _receiver) = std::sync::mpsc::channel();
        let (worker, root, child) = booted(&stand, sender);
        request(&stand.dir, 5000.0, true);
        assert_eq!(worker.join().unwrap(), 0);
        let stopped = stand.stopped();
        assert_eq!(stopped["treeAbsent"], true);
        assert_eq!(stopped["treeForced"], true);
        assert_eq!(stopped["deviceState"], "Shutdown");
        assert!(!process_alive(root) && !process_alive(child));
        stand.remove();
    }

    #[test]
    fn a_failed_shutdown_command_never_leaves_the_tree_running_and_spares_bystanders() {
        let stand = simulated("stuck", BOOT, "exit 1");
        let mut bystander = mention(&stand);
        let (sender, _receiver) = std::sync::mpsc::channel();
        let (worker, root, child) = booted(&stand, sender);
        request(&stand.dir, 5000.0, true);
        assert_eq!(worker.join().unwrap(), 0);
        let stopped = stand.stopped();
        assert_eq!(stopped["shutdownStatus"], 1);
        assert_eq!(stopped["treeForced"], true);
        assert_eq!(stopped["treeAbsent"], true);
        assert_eq!(stopped["deviceState"], "Shutdown");
        assert!(!process_alive(root) && !process_alive(child));
        // The forced path signalled the simulator's own tree only.
        assert!(bystander.try_wait().unwrap().is_none());
        bystander.kill().unwrap();
        bystander.wait().unwrap();
        stand.remove();
    }

    #[test]
    fn a_simulator_that_stops_by_itself_ends_the_lease_with_a_receipt() {
        let stand = simulated("gone", BOOT, GRACEFUL);
        let (sender, receiver) = std::sync::mpsc::channel();
        let (worker, root, _child) = booted(&stand, sender);
        let companion = receiver.recv().unwrap() as i32;
        unsafe { libc::kill(root, libc::SIGTERM) };
        assert_eq!(worker.join().unwrap(), 0);
        let stopped = stand.stopped();
        assert_eq!(stopped["reason"], "exited");
        assert_eq!(stopped["treeAbsent"], true);
        assert_eq!(stopped["deviceState"], "Shutdown");
        // Access ends while the shutdown is still being proven.
        assert_eq!(
            read_bounded(&stand.dir, FENCED).unwrap().unwrap()["reason"],
            "exited"
        );
        assert!(!group_alive(companion));
        stand.remove();
    }

    #[test]
    fn a_boot_that_coresimulator_refuses_ends_in_the_stop_and_its_receipt() {
        let stand = simulated("boot", "exit 1", GRACEFUL);
        let prepared = prepare(&stand.path, &stand.launch, clock).unwrap();
        let mut spawned = None;
        assert_eq!(
            run(prepared, clock, |line| spawned = line["childPid"].as_i64()),
            0
        );
        let stopped = stand.stopped();
        assert_eq!(stopped["reason"], "boot");
        assert_eq!(stopped["bootStatus"], 1);
        // The device never left Shutdown, so no tree was expected and none was seen.
        assert_eq!(stopped["deviceState"], "Shutdown");
        assert_eq!(stopped["treeObserved"], false);
        assert_eq!(stopped["treeAbsent"], true);
        assert!(stopped["settledSeconds"].as_f64().unwrap() >= SETTLE.as_secs_f64());
        assert!(!group_alive(
            spawned.expect("the companion was spawned") as i32
        ));
        assert_eq!(status(&stand.path).unwrap(), "free");
        stand.remove();
    }

    /// Runs the supervisor against a boot whose client blocks, fences it while the boot is
    /// in flight and returns once the supervisor has killed that client.
    fn interrupted(stand: &Stand) -> std::thread::JoinHandle<i32> {
        let prepared = prepare(&stand.path, &stand.launch, clock).unwrap();
        let worker = std::thread::spawn(move || run(prepared, clock, |_| {}));
        until("the boot request", 10, || {
            stand.set.join(format!("{UDID}.requested")).exists()
        });
        request(&stand.dir, 5000.0, true);
        until("the fence", 10, || stand.dir.join(FENCED).exists());
        worker
    }

    #[test]
    fn an_interrupted_boot_that_completes_late_is_shut_down_before_any_receipt() {
        // CoreSimulator still reports Shutdown and the process table is empty for a while
        // after the client was killed. Only the settling period covers this window.
        let stand = simulated("late", BLOCKED_BOOT, GRACEFUL);
        let worker = interrupted(&stand);
        std::thread::sleep(Duration::from_millis(2500));
        assert!(!stand.dir.join(STOPPED).exists(), "no receipt on absence");
        assert_eq!(status(&stand.path).unwrap(), "held");
        let root = stand.appear();
        let child = number(stand.device().join("data/launchd_bootstrap.plist.child"));
        assert_eq!(worker.join().unwrap(), 0);
        let stopped = stand.stopped();
        assert_eq!(stopped["reason"], "fenced");
        assert_eq!(stopped["bootStatus"], Value::Null);
        // The late simulator was observed, shut down by this supervisor and proven gone.
        assert_eq!(stopped["treeObserved"], true);
        assert_eq!(stopped["shutdownStatus"], 0);
        assert_eq!(stopped["deviceState"], "Shutdown");
        assert_eq!(stopped["treeAbsent"], true);
        assert!(!process_alive(root) && !process_alive(child));
        assert_eq!(status(&stand.path).unwrap(), "free");
        stand.remove();
    }

    #[test]
    fn a_device_that_is_still_booting_holds_the_supervisor_however_long_its_tree_is_absent() {
        // CoreSimulator reports Booting with no process yet, for longer than the settling
        // period. An empty process table is not evidence while the device is not shut down.
        let stand = simulated("booting", BLOCKED_BOOT, GRACEFUL);
        let worker = interrupted(&stand);
        stand.state("Booting");
        std::thread::sleep(SETTLE + Duration::from_millis(1500));
        assert!(
            !stand.dir.join(STOPPED).exists(),
            "no receipt while booting"
        );
        assert_eq!(status(&stand.path).unwrap(), "held");
        let root = stand.appear();
        assert_eq!(worker.join().unwrap(), 0);
        let stopped = stand.stopped();
        assert_eq!(stopped["treeObserved"], true);
        assert_eq!(stopped["deviceState"], "Shutdown");
        assert_eq!(stopped["treeAbsent"], true);
        assert!(!process_alive(root));
        stand.remove();
    }

    #[test]
    fn a_booted_simulator_whose_tree_is_never_observed_is_reported_unproven_not_absent() {
        // CoreSimulator accepts the boot and reports Booted, but nothing in the process
        // table is the device's launchd_sim: the premise of the proof does not hold.
        let stand = simulated("unnamed", UNNAMED_BOOT, GRACEFUL);
        let prepared = prepare(&stand.path, &stand.launch, clock).unwrap();
        let worker = std::thread::spawn(move || run(prepared, clock, |_| {}));
        let quiet = number(stand.set.join(format!("{UDID}.pid")));
        assert_eq!(worker.join().unwrap(), 0);
        let stopped = stand.stopped();
        // The lease ends by itself: a simulator whose stop cannot be proven does not run on.
        assert_eq!(stopped["reason"], "unobserved");
        assert_eq!(stopped["bootStatus"], 0);
        assert_eq!(stopped["deviceState"], "Shutdown");
        assert_eq!(stopped["treeObserved"], false);
        assert_eq!(stopped["treeAbsent"], false);
        assert_eq!(
            stand.status(),
            json!({"version": 1, "tree": "absent", "observed": false})
        );
        assert!(!process_alive(quiet), "the graceful shutdown still ran");
        stand.remove();
    }

    static STALLED: AtomicBool = AtomicBool::new(false);
    fn stalling() -> Result<Vec<Process>> {
        if STALLED.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_secs(4));
            return Err("stalled".into());
        }
        inventory()
    }

    #[test]
    fn a_stalled_inventory_never_delays_the_fence() {
        let stand = simulated("stalled", BOOT, GRACEFUL);
        let mut prepared = prepare(&stand.path, &stand.launch, clock).unwrap();
        prepared.simulator.as_mut().unwrap().inventory = stalling;
        let worker = std::thread::spawn(move || run(prepared, clock, |_| {}));
        until("the recorded tree", 10, || {
            read_bounded(&stand.dir, TREE)
                .is_ok_and(|tree| tree.is_some_and(|tree| tree["observed"] == true))
        });
        // Every inventory now stalls for four seconds. Within one sample interval the
        // sampling thread is inside one, and stays there across the fence below.
        STALLED.store(true, Ordering::SeqCst);
        std::thread::sleep(SAMPLE_INTERVAL + Duration::from_millis(500));
        let fenced = Instant::now();
        request(&stand.dir, 5000.0, true);
        until("the fence", 10, || stand.dir.join(FENCED).exists());
        assert!(
            fenced.elapsed() < Duration::from_secs(1),
            "the fence waited {:?} for an inventory",
            fenced.elapsed()
        );
        STALLED.store(false, Ordering::SeqCst);
        assert_eq!(worker.join().unwrap(), 0);
        assert_eq!(stand.stopped()["treeAbsent"], true);
        stand.remove();
    }

    #[test]
    fn a_foreign_occupied_or_unreported_device_is_refused_before_anything_spawns() {
        let stand = simulated("refuse", BOOT, GRACEFUL);
        // Another directory, however private, is not this assignment's device set.
        let other = stand.dir.join("other-set");
        std::fs::create_dir(&other).unwrap();
        std::fs::set_permissions(&other, std::os::unix::fs::PermissionsExt::from_mode(0o700))
            .unwrap();
        for (key, value) in [
            ("deviceSet", json!(other.to_str().unwrap())),
            ("deviceSet", json!(std::env::temp_dir().to_str().unwrap())),
            ("udid", json!("not-a-device")),
            ("udid", json!("../outside")),
            ("tool", json!(["simctl"])),
            ("tool", json!([])),
        ] {
            let mut changed = stand.launch.clone();
            changed["simulator"][key] = value;
            assert!(prepare(&stand.path, &changed, clock).is_err(), "{key}");
        }
        let refused = |launch: &Value| {
            let prepared = prepare(&stand.path, launch, clock).unwrap();
            let code = run(prepared, clock, |_| {});
            assert!(!stand.dir.join(SUPERVISOR).exists() && !stand.dir.join(STOPPED).exists());
            code
        };
        // A device that CoreSimulator does not report as shut down was not left by this launch.
        for state in ["Booting", "ShuttingDown"] {
            stand.state(state);
            assert_eq!(refused(&stand.launch), REFUSED, "{state}");
        }
        stand.state("Shutdown");
        // A CoreSimulator that does not answer could never prove a stop later.
        let mut silent = stand.launch.clone();
        silent["simulator"]["tool"] = json!(["/usr/bin/false"]);
        assert_eq!(refused(&silent), REFUSED);
        // A device whose launchd_sim already runs is occupied.
        let mut occupant = Command::new(stand.dir.join("launchd_sim"))
            .arg(stand.device().join("data/launchd_bootstrap.plist"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        until("the occupant", 10, || stand.status()["tree"] == "present");
        assert_eq!(refused(&stand.launch), REFUSED);
        assert!(
            process_alive(occupant.id() as i32),
            "an occupant is only observed"
        );
        unsafe { libc::kill(occupant.id() as i32, libc::SIGTERM) };
        occupant.wait().unwrap();
        until("an empty device", 10, || stand.status()["tree"] == "absent");
        assert!(simulator_status(&stand.path, other.to_str().unwrap(), UDID).is_err());
        assert!(simulator_status(&stand.path, stand.set(), "../outside").is_err());
        stand.remove();
    }

    #[test]
    fn a_lost_supervisors_recorded_members_keep_the_tree_present_until_they_are_gone() {
        let stand = simulated("lost", BOOT, GRACEFUL);
        // A member that names nothing: only the record left by the supervisor finds it.
        let mut member = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let pid = member.id() as i32;
        let started = inventory()
            .unwrap()
            .into_iter()
            .find(|p| p.pid == pid)
            .unwrap()
            .started;
        let record = |members: Value, truncated: bool, observed: bool| {
            save(
                &stand.dir,
                TREE,
                &json!({"version": 1, "members": members, "truncated": truncated, "observed": observed}),
            )
            .unwrap()
        };
        record(json!([[pid, started]]), false, true);
        assert_eq!(
            stand.status(),
            json!({"version": 1, "tree": "present", "observed": true})
        );
        // The same PID with another start time is another process.
        record(json!([[pid, "Thu Jan 1 00:00:00 1970"]]), false, true);
        assert_eq!(stand.status()["tree"], "absent");
        // A record that lost members can never prove absence.
        record(json!([]), true, true);
        assert_eq!(stand.status()["tree"], "unknown");
        // An empty tree that was never observed says so.
        record(json!([]), false, false);
        assert_eq!(
            stand.status(),
            json!({"version": 1, "tree": "absent", "observed": false})
        );
        record(json!([[pid, started]]), false, true);
        member.kill().unwrap();
        member.wait().unwrap();
        assert_eq!(stand.status()["tree"], "absent");
        stand.remove();
    }

    #[test]
    fn the_emulator_log_is_capped() {
        let dir = storage("log");
        let path = dir.join("emulator.log");
        let log = OpenOptions::new()
            .append(true)
            .create(true)
            .open(&path)
            .unwrap();
        let (reader, mut writer) = io::pipe().unwrap();
        let copier = std::thread::spawn(move || copy_capped(reader, log));
        let chunk = vec![b'x'; 1 << 20];
        for _ in 0..(LOG_LIMIT >> 20) + 2 {
            writer.write_all(&chunk).unwrap();
        }
        drop(writer);
        copier.join().unwrap();
        let size = std::fs::metadata(&path).unwrap().len();
        assert!(size > LOG_LIMIT && size < LOG_LIMIT + 4096, "{size}");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
