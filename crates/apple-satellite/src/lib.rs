//! Outbound Linux-on-Apple lease supervision. No guest capability is inferred from boot.
#![cfg(unix)]
use canaveral_runner_client::{Binding, Identity, LeaseRoute, Transport};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::Duration,
};
pub mod clock;
mod private;
pub type Result<T> = std::result::Result<T, &'static str>;
/// Interval between heartbeat reports while a guest runs; replies carry renewals and stop intent.
const REPORT_EVERY: Duration = Duration::from_secs(1);
/// Bounded wait for the native power cut and handle release after a fence.
const STOP_WAIT: Duration = Duration::from_secs(60);
const QUICK: Duration = Duration::from_secs(30);
/// Native MachineStore limits for headless Linux machines.
const NATIVE_CPU: std::ops::RangeInclusive<u64> = 1..=64;
const NATIVE_MEMORY_GIB: std::ops::RangeInclusive<u64> = 1..=128;
const NATIVE_DISK_GIB: std::ops::RangeInclusive<u64> = 4..=1024;
#[cfg(target_os = "macos")]
const LSOF: &str = "/usr/sbin/lsof";
#[cfg(not(target_os = "macos"))]
const LSOF: &str = "/usr/bin/lsof";
fn io<T>(r: std::io::Result<T>) -> Result<T> {
    r.map_err(|_| "local IO failed; retain state")
}
fn decode<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    serde_json::from_slice(bytes).map_err(|_| "invalid local/protocol JSON")
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Image {
    pub id: String,
    pub revision: String,
    pub arch: String,
    pub backend: String,
    pub digest: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Installed {
    /// Operator attests this exact digest contains no reusable guest credentials.
    pub credential_free: bool,
    pub image: Image,
    pub path: PathBuf,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub origin: String,
    pub identity: PathBuf,
    pub binding: Binding,
    pub state: PathBuf,
    pub helper: PathBuf,
    pub helper_sha256: String,
    pub signing_requirement: String,
    pub ca: Option<PathBuf>,
    pub inventory: Vec<Installed>,
    pub max_cpu: u64,
    pub max_memory_mi_b: u64,
    pub max_disk_gi_b: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Resources {
    cpu: u64,
    memory_mi_b: u64,
    disk_gi_b: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Lease {
    state: String,
    revision: u64,
    expires_at: f64,
    controller_now: f64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Assignment {
    id: uuid::Uuid,
    claim_id: uuid::Uuid,
    lease_id: uuid::Uuid,
    member_id: uuid::Uuid,
    domain_id: uuid::Uuid,
    sequence: u64,
    closed: bool,
    image: Image,
    resources: Resources,
    capabilities: Vec<String>,
    required_capabilities: Vec<String>,
    lease: Lease,
    stop_requested: bool,
}
/// Durable per-claim journal. Every flag is forward-only within one claim.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    config: Value,
    claim_id: uuid::Uuid,
    assignment: Option<Assignment>,
    /// Published before workspace/prepare/run: irreversible, even when an effect's result was lost.
    launch_intent: bool,
    prepared: bool,
    fenced: bool,
    /// Declined before launch intent: nothing was created for this assignment.
    abandoned: bool,
    boot: f64,
    boot_session_id: uuid::Uuid,
    deadline: f64,
    revision: u64,
    /// Positive in-process stop proof: helper exited, runtime lock free, no handles on the workspace.
    stopped: bool,
    terminal: bool,
    cleaning: bool,
    cleaned: bool,
    sequence: u64,
    pending: Option<Value>,
    released: bool,
}
impl Journal {
    fn fresh(config: Value) -> Result<Self> {
        let mut bytes = [0; 16];
        getrandom::fill(&mut bytes).map_err(|_| "randomness unavailable")?;
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        Ok(Self {
            config,
            claim_id: uuid::Uuid::from_bytes(bytes),
            assignment: None,
            launch_intent: false,
            prepared: false,
            fenced: false,
            abandoned: false,
            boot: 0.0,
            boot_session_id: uuid::Uuid::nil(),
            deadline: 0.0,
            revision: 0,
            stopped: false,
            terminal: false,
            cleaning: false,
            cleaned: false,
            sequence: 0,
            pending: None,
            released: false,
        })
    }
}
pub trait Controller {
    fn request(&mut self, route: LeaseRoute, body: Value) -> Result<Value>;
}
pub struct Authenticated<'a> {
    pub identity: &'a Identity,
    pub transport: &'a Transport,
}
impl Controller for Authenticated<'_> {
    fn request(&mut self, route: LeaseRoute, body: Value) -> Result<Value> {
        self.identity
            .linux_lease_request(self.transport, route, body)
            .map_err(|_| "controller reply missing/rejected; intent retained")
    }
}
fn hash_file(path: &Path) -> Result<String> {
    artifact_hash(path, false)
}
fn artifact_hash(path: &Path, raw: bool) -> Result<String> {
    let parent = private::walk(path.parent().ok_or("absolute file required")?)?;
    drop(parent);
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let mut f = io(std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path))?;
    let m = io(f.metadata())?;
    if !m.is_file()
        || m.nlink() != 1
        || m.mode() & 0o222 != 0
        || !(m.uid() == 0 || m.uid() == unsafe { libc::geteuid() })
    {
        return Err("installed artifact must be immutable regular file");
    }
    let mut hash = Sha256::new();
    if raw {
        let mut magic = [0; 4];
        io(f.read_exact(&mut magic))?;
        // Swift detects QCOW2 by magic, regardless of the source filename.
        if magic == *b"QFI\xfb" {
            return Err("installed image must be raw, not QCOW2");
        }
        hash.update(magic);
    }
    let mut buf = [0; 65536];
    loop {
        let n = io(f.read(&mut buf))?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    Ok(format!("sha256:{:x}", hash.finalize()))
}
fn command(helper: &Path, args: &[&str], input: Option<&Value>, limit: Duration) -> Result<Value> {
    let mut child = io(Command::new(helper)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn())?;
    if let Some(input) = input {
        io(child
            .stdin
            .take()
            .ok_or("missing stdin")?
            .write_all(input.to_string().as_bytes()))?;
    }
    drop(child.stdin.take());
    let start = clock::Clock::now();
    loop {
        if let Some(status) = io(child.try_wait())? {
            if !status.success() {
                return Err("helper rejected operation");
            }
            let mut bytes = Vec::new();
            io(child
                .stdout
                .take()
                .ok_or("missing stdout")?
                .take(65537)
                .read_to_end(&mut bytes))?;
            if bytes.len() > 65536 {
                return Err("helper output too large");
            }
            return if bytes.starts_with(b"{") {
                decode(&bytes)
            } else {
                Ok(Value::Null)
            };
        }
        if start.elapsed() > limit {
            let _ = child.kill();
            let _ = child.wait();
            return Err("helper timeout; effect unknown");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
/// Load the operator's CA through the same pinned trust-file boundary as configuration.
pub fn read_ca(path: &Path) -> Result<Vec<u8>> {
    private::trust_file(path, false)
}
pub fn read_config(path: &Path) -> Result<Config> {
    decode(&private::trust_file(path, true)?)
}
fn host_arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "amd64"
    }
}
/// Local artifact pins. Everything here runs before any claim is sent.
fn validate_local(c: &Config) -> Result<()> {
    if c.identity.starts_with(&c.state)
        || c.state.starts_with(&c.identity)
        || !c.identity.is_absolute()
        || !c.state.is_absolute()
        || c.max_disk_gi_b > u64::MAX / 1073741824
        || c.inventory.is_empty()
        || c.max_cpu == 0
        || c.max_memory_mi_b == 0
        || c.max_disk_gi_b == 0
        || c.signing_requirement.trim().is_empty()
        || hash_file(&c.helper)? != c.helper_sha256
    {
        return Err("invalid helper or local configuration");
    }
    for item in &c.inventory {
        if !item.credential_free
            || item.image.backend != "appleVirtualization"
            || item.image.arch != host_arch()
            || item.path.extension().and_then(|s| s.to_str()) != Some("raw")
            || artifact_hash(&item.path, true)? != item.image.digest
        {
            return Err("installed image mismatch");
        }
    }
    Ok(())
}
fn validate_config(c: &Config) -> Result<()> {
    validate_local(c)?;
    #[cfg(not(target_os = "macos"))]
    return Err("Apple virtualization requires macOS");
    #[cfg(target_os = "macos")]
    {
        // `=` makes codesign parse requirement text; without it, -R names a requirement file.
        if !io(Command::new("/usr/bin/codesign")
            .args(["--verify", "--strict", "-R"])
            .arg(format!("={}", c.signing_requirement))
            .arg(&c.helper)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status())?
        .success()
        {
            return Err("helper signature requirement failed");
        }
        // The pinned file may not change between hashing and signature verification.
        if hash_file(&c.helper)? != c.helper_sha256 {
            return Err("helper changed during verification");
        }
        command(&c.helper, &["check"], None, QUICK)?;
        Ok(())
    }
}
pub struct Satellite {
    config: Config,
    dir: private::Directory,
    state: Journal,
}
impl Satellite {
    /// Completes artifact, signature and binding-local preflight before any claim.
    pub fn open(config: Config) -> Result<Self> {
        validate_config(&config)?;
        Self::open_preflighted(config)
    }
    fn open_preflighted(config: Config) -> Result<Self> {
        let dir = private::Directory::open(&config.state)?;
        let fingerprint = serde_json::to_value(&config).map_err(|_| "invalid config")?;
        let state = if let Some(bytes) = dir.read_optional("state.json")? {
            let s: Journal = decode(&bytes)?;
            if s.config != fingerprint {
                return Err("saved binding/config differs; reconcile");
            }
            s
        } else {
            Journal::fresh(fingerprint)?
        };
        let s = Self { config, dir, state };
        s.save()?;
        Ok(s)
    }
    fn save(&self) -> Result<()> {
        self.dir.write(
            "state.json",
            "state.next",
            &serde_json::to_vec(&self.state).map_err(|_| "journal encode failed")?,
        )
    }
    fn assignment(&self) -> Result<&Assignment> {
        self.state.assignment.as_ref().ok_or("no assignment")
    }
    fn workspace(&self) -> PathBuf {
        self.config.state.join("workspace")
    }
    fn machine(&self) -> Result<PathBuf> {
        Ok(self
            .workspace()
            .join(self.assignment()?.member_id.to_string().to_uppercase()))
    }
    /// Protocol identity. A mismatch is not ours to report on, so it is held, not declined.
    fn check_identity(&self, a: &Assignment) -> Result<()> {
        if a.claim_id != self.state.claim_id
            || a.closed
            || a.sequence != 0
            || a.id.is_nil()
            || a.member_id.is_nil()
            || a.lease_id.is_nil()
            || a.domain_id.is_nil()
            || a.lease.revision == 0
            || !a.lease.expires_at.is_finite()
            || !a.lease.controller_now.is_finite()
        {
            return Err("assignment identity invalid; hold");
        }
        Ok(())
    }
    /// Pre-launch admission. Any failure has had no local effect and is declined.
    fn validate_assignment(&self, a: &Assignment) -> Result<&Installed> {
        let r = &a.resources;
        if r.cpu > self.config.max_cpu
            || !NATIVE_CPU.contains(&r.cpu)
            || !r.memory_mi_b.is_multiple_of(1024)
            || !NATIVE_MEMORY_GIB.contains(&(r.memory_mi_b / 1024))
            || r.memory_mi_b > self.config.max_memory_mi_b
            || !NATIVE_DISK_GIB.contains(&r.disk_gi_b)
            || r.disk_gi_b > self.config.max_disk_gi_b
            || a.lease.expires_at <= a.lease.controller_now
            || a.stop_requested
            || a.lease.state != "provisioning"
        {
            return Err("assignment not admissible; declined");
        }
        let installed = self
            .config
            .inventory
            .iter()
            .find(|i| i.image == a.image)
            .ok_or("assignment image not installed; declined")?;
        if io(std::fs::metadata(&installed.path))?.len() > r.disk_gi_b * 1073741824 {
            return Err("installed disk exceeds assigned storage; declined");
        }
        Ok(installed)
    }
    fn helper_clock(&self) -> Result<(uuid::Uuid, f64)> {
        let clock = command(&self.config.helper, &["lease-clock"], None, QUICK)?;
        let boot_id: uuid::Uuid = serde_json::from_value(clock["bootSessionID"].clone())
            .map_err(|_| "invalid boot identity")?;
        let continuous = clock["continuous"].as_f64().ok_or("invalid helper clock")?;
        if boot_id.is_nil()
            || !continuous.is_finite()
            || (continuous - clock::now().as_secs_f64()).abs() > 2.0
        {
            return Err("helper clock mismatch");
        }
        Ok((boot_id, continuous))
    }
    fn admit(&self) -> Result<Installed> {
        let a = self.assignment()?;
        let installed = self.validate_assignment(a)?.clone();
        if self.expired() {
            return Err("assignment expired before launch; declined");
        }
        // The deadline is measured on this boot's continuous clock.
        if self.helper_clock()?.0 != self.state.boot_session_id {
            return Err("host rebooted after claim; declined");
        }
        if hash_file(&installed.path)? != a.image.digest {
            return Err("installed image changed; declined");
        }
        Ok(installed)
    }
    fn write_machine(&self, name: &str, body: Value) -> Result<()> {
        // Machine directory is created exclusively below our locked workspace by prepare.
        self.dir.check()?;
        let path = self.machine()?;
        let _ = private::walk(&path)?;
        let temp = path.join(format!("{name}.next"));
        // Only an unpublished candidate from an interrupted write can exist here.
        let _ = std::fs::remove_file(&temp);
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = io(std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&temp))?;
        io(f.write_all(body.to_string().as_bytes()))?;
        io(f.sync_all())?;
        io(std::fs::rename(temp, path.join(name)))?;
        io(io(File::open(path))?.sync_all())
    }
    fn authorize(&self) -> Result<()> {
        let a = self.assignment()?;
        self.write_machine("lease-authorization.json",json!({"version":1,"machineID":a.member_id,
            "leaseID":a.lease_id,"revision":self.state.revision,"boot":self.state.boot,
            "bootSessionID":self.state.boot_session_id,"deadline":self.state.deadline,"fenced":self.state.fenced}))
    }
    /// Sticky. Signals the native helper only while a prepared machine may still execute.
    fn fence(&mut self) -> Result<()> {
        self.state.fenced = true;
        self.save()?;
        if self.state.prepared && !self.state.stopped && !self.state.cleaning {
            self.authorize()?;
            self.write_machine(
                "power-off.request",
                json!({"id":self.assignment()?.member_id,"boot":self.state.boot}),
            )?;
        }
        Ok(())
    }
    fn expired(&self) -> bool {
        clock::now().as_secs_f64() >= self.state.deadline
    }
    fn receipt(&self) -> Result<Value> {
        let a = self.assignment()?;
        let s = &self.state;
        let failure = if s.abandoned {
            Some("provisioning")
        } else if s.fenced {
            Some("runtime")
        } else {
            None
        };
        let cleanup = if s.cleaned {
            "complete"
        } else if s.terminal && s.stopped {
            "running"
        } else if s.terminal && s.fenced {
            "blocked"
        } else {
            "pending"
        };
        Ok(
            json!({"assignmentId":a.id,"sequence":s.sequence+1,"receipt":{
            "leaseId":a.lease_id,"memberId":a.member_id,"backend":a.image.backend,"imageDigest":a.image.digest,
            "observedRevision":s.revision,"runtimeState":if s.stopped {"stopped"} else {"unknown"},
            // No guest probe exists in this slice: boot never implies command, PTY or files.
            "ready":{"command":false,"pty":false,"files":false},
            "failure":failure,"executionStopped":s.stopped,"storageRemoved":s.cleaned,
            "credentialsErased":s.cleaned,"cleanup":cleanup}}),
        )
    }
    /// Sends the persisted pending report, or persists then sends the current one.
    fn report(&mut self, controller: &mut impl Controller) -> Result<()> {
        if self.state.pending.is_none() {
            self.state.pending = Some(self.receipt()?);
            self.save()?;
        }
        let start = clock::now().as_secs_f64();
        let reply = controller.request(
            LeaseRoute::Report,
            self.state.pending.clone().ok_or("missing report")?,
        )?;
        if reply["assignmentId"] != json!(self.assignment()?.id)
            || reply["sequence"] != json!(self.state.sequence + 1)
        {
            return Err("report acknowledgment identity mismatch");
        }
        let lease: Lease =
            serde_json::from_value(reply["lease"].clone()).map_err(|_| "invalid report lease")?;
        if !lease.expires_at.is_finite() || !lease.controller_now.is_finite() {
            return Err("invalid lease clock");
        }
        // Expiry is evaluated before renewal, including network latency and sleep.
        let mut fence = self.state.fenced
            || self.expired()
            || reply["stopRequested"] == true
            || !matches!(lease.state.as_str(), "provisioning" | "ready");
        let mut renewed = false;
        if !fence && lease.revision > self.state.revision {
            self.state.deadline = start + (lease.expires_at - lease.controller_now).max(0.0);
            self.state.revision = lease.revision;
            fence = self.expired();
            renewed = !fence;
        }
        if matches!(lease.state.as_str(), "released" | "expired" | "failed") {
            self.state.terminal = true;
        }
        self.state.sequence += 1;
        self.state.pending = None;
        self.state.released = reply["released"] == true && self.state.cleaned;
        self.save()?;
        // Native effects follow durable bookkeeping, so a failed write cannot replay a report.
        if fence {
            self.fence()?;
        } else if renewed && self.state.prepared && !self.state.stopped {
            self.authorize()?;
        }
        Ok(())
    }
    /// Replays any pending report, then reports the current durable state.
    fn sync(&mut self, controller: &mut impl Controller) -> Result<()> {
        if self.state.pending.is_some() {
            self.report(controller)?;
            if self.state.released {
                return Ok(());
            }
        }
        self.report(controller)
    }
    /// Positive stop evidence only. Missing tools, errors or any handle mean unproven.
    fn prove_stopped(&self, child: Option<&mut Child>) -> Result<bool> {
        if let Some(child) = child {
            if io(child.try_wait())?.is_none() {
                return Ok(false);
            }
        }
        let machine = self.machine()?;
        if std::fs::symlink_metadata(&machine).is_ok()
            && command(
                &self.config.helper,
                &["inspect", machine.to_str().ok_or("invalid path")?],
                None,
                QUICK,
            )?["locked"]
                != false
        {
            return Ok(false);
        }
        // lsof covers the whole owned workspace: disks, EFI, partial preparation and credentials.
        let output = io(Command::new(LSOF)
            .args(["-nP", "-F", "p", "+D"])
            .arg(self.workspace())
            .output())?;
        Ok(output.status.code() == Some(1) && output.stdout.is_empty() && output.stderr.is_empty())
    }
    fn wait_stopped(&mut self, mut child: Option<&mut Child>) -> Result<bool> {
        let wait = clock::Clock::now();
        while wait.elapsed() < STOP_WAIT {
            if self.prove_stopped(child.as_deref_mut())? {
                self.state.stopped = true;
                self.save()?;
                return Ok(true);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Ok(false)
    }
    /// After positive stop (or decline): terminal acknowledgment, deletion, then release.
    fn finish(&mut self, controller: &mut impl Controller) -> Result<()> {
        if !self.state.cleaned {
            self.sync(controller)?;
            if !self.state.terminal {
                return Err("awaiting terminal lease acknowledgment; reservation held");
            }
            let resumed = self.state.cleaning;
            self.state.cleaning = true;
            self.save()?;
            self.dir.cleanup_workspace(resumed)?;
            self.state.cleaned = true;
            self.save()?;
        }
        self.sync(controller)?;
        if self.state.released {
            Ok(())
        } else {
            Err("cleanup report awaiting release acknowledgment")
        }
    }
    fn decline(&mut self, controller: &mut impl Controller, reason: &'static str) -> Result<()> {
        // Only an assignment with no launch intent and no workspace can be declined.
        if self.state.launch_intent || !self.dir.absent("workspace")? {
            return Err("unreconciled workspace; hold");
        }
        self.state.abandoned = true;
        self.state.fenced = true;
        self.state.stopped = true;
        self.state.cleaning = true;
        self.state.cleaned = true;
        self.save()?;
        self.finish(controller)?;
        Err(reason)
    }
    /// One durable claim per journal. Restart never repeats prepare/run after launch intent.
    pub fn run_once(&mut self, controller: &mut impl Controller) -> Result<()> {
        if self.state.released {
            // The closed assignment's workspace is deleted; a new claim starts a new journal.
            self.state = Journal::fresh(self.state.config.clone())?;
            self.save()?;
        }
        if self.state.assignment.is_none() {
            let (boot_id, _) = self.helper_clock()?;
            // A replayed claim returns the controller's current clock, so the latest send time
            // is a conservative base. A lost reply keeps the same claimId for exact replay.
            let start = clock::now().as_secs_f64();
            let response =
                controller.request(LeaseRoute::Claim, json!({"claimId":self.state.claim_id}))?;
            if response["assignment"].is_null() {
                return Ok(());
            }
            let a: Assignment = serde_json::from_value(response["assignment"].clone())
                .map_err(|_| "invalid claim reply")?;
            self.check_identity(&a)?;
            self.state.deadline = start + (a.lease.expires_at - a.lease.controller_now).max(0.0);
            self.state.revision = a.lease.revision;
            self.state.boot_session_id = boot_id;
            self.state.assignment = Some(a);
            self.save()?;
        }
        if self.state.cleaned {
            return self.finish(controller);
        }
        if self.state.launch_intent || self.state.fenced {
            self.fence()?;
            if self.state.stopped {
                return self.finish(controller);
            }
            // Replaying an old pending receipt cannot authorize a recovered launch.
            let _ = self.sync(controller);
            return Err(
                "recovered intent: no relaunch; stop/cleanup proof requires reconciliation",
            );
        }
        let installed = match self.admit() {
            Ok(installed) => installed,
            Err(reason) => return self.decline(controller, reason),
        };
        let a = self.assignment()?.clone();
        // Even prepare is never retried after an interrupted effect.
        self.state.launch_intent = true;
        self.state.boot = clock::now().as_secs_f64();
        self.save()?;
        self.dir.workspace()?;
        let remaining = Duration::from_secs_f64(
            (self.state.deadline - clock::now().as_secs_f64()).clamp(0.0, 1800.0),
        );
        let prepared = command(
            &self.config.helper,
            &["prepare"],
            Some(&json!({
                "id":a.member_id,"leaseID":a.lease_id,"name":"leased-linux","os":"linux","mode":"headless",
                "cpu":a.resources.cpu,"memoryMiB":a.resources.memory_mi_b,"diskGiB":a.resources.disk_gi_b,
                "image":installed.path,"directory":self.workspace()
            })),
            remaining,
        );
        if prepared.is_ok() {
            self.state.prepared = true;
            self.save()?;
            self.write_machine("runner-launch.json", json!({"attemptedAt":self.state.boot}))?;
        }
        if prepared.is_err() || self.expired() {
            // The prepare process has exited (or was killed and reaped); no run was started.
            self.fence()?;
            if self.wait_stopped(None)? {
                self.finish(controller)?;
            }
            return Err("prepare failed or lease expired before run; fenced");
        }
        self.authorize()?;
        let mut child = io(Command::new(&self.config.helper)
            .arg("run")
            .arg(self.machine()?)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn())?;
        let mut last: Option<clock::Clock> = None;
        while !self.state.fenced {
            if self.expired() || io(child.try_wait())?.is_some() {
                self.fence()?;
                break;
            }
            if self.state.pending.is_some() || last.is_none_or(|t| t.elapsed() >= REPORT_EVERY) {
                last = Some(clock::Clock::now());
                // A lost reply keeps the exact pending report; local expiry still fences.
                let _ = self.report(controller);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        // Native authorization also cuts power independently if this process dies.
        if self.wait_stopped(Some(&mut child))? {
            return self.finish(controller);
        }
        Err("stop unproven; reservation held")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    fn boot_id() -> uuid::Uuid {
        uuid::Uuid::from_u128(123)
    }
    fn install_helper(c: &mut Config, script: &str) {
        std::fs::set_permissions(&c.helper, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(&c.helper, script).unwrap();
        std::fs::set_permissions(&c.helper, std::fs::Permissions::from_mode(0o500)).unwrap();
        c.helper_sha256 = hash_file(&c.helper).unwrap();
    }
    fn clock_json() -> Value {
        json!({"continuous":clock::now().as_secs_f64(),"bootSessionID":boot_id(),"version":1})
    }
    fn machine_of(c: &Config) -> PathBuf {
        c.state
            .join("workspace")
            .join(uuid::Uuid::from_u128(12).to_string().to_uppercase())
    }
    fn fixture_with(helper_script: impl Fn(&Path) -> String) -> (tempfile::TempDir, Config) {
        let tmp =
            tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let root = tmp.path();
        let helper = root.join("helper");
        std::fs::write(&helper, "").unwrap();
        let image = root.join("linux.raw");
        std::fs::write(&image, b"fixture installed disk").unwrap();
        std::fs::set_permissions(&image, std::fs::Permissions::from_mode(0o400)).unwrap();
        let mut c = Config {
            origin: "https://localhost".into(),
            identity: root.join("identity"),
            binding: Binding {
                controller_id: uuid::Uuid::from_u128(1),
                runner_id: uuid::Uuid::from_u128(2),
                generation: 1,
                incarnation_id: uuid::Uuid::from_u128(3),
            },
            state: root.join("state"),
            helper_sha256: String::new(),
            helper,
            signing_requirement: "anchor apple generic".into(),
            ca: None,
            inventory: vec![Installed {
                credential_free: true,
                image: Image {
                    id: "linux".into(),
                    revision: "1".into(),
                    arch: host_arch().into(),
                    backend: "appleVirtualization".into(),
                    digest: hash_file(&image).unwrap(),
                },
                path: image,
            }],
            max_cpu: 2,
            max_memory_mi_b: 2048,
            max_disk_gi_b: 4,
        };
        let script = helper_script(&machine_of(&c));
        install_helper(&mut c, &script);
        (tmp, c)
    }
    /// The clock is sampled when a fixture is built; tests complete well within tolerance.
    fn fixture() -> (tempfile::TempDir, Config) {
        fixture_with(|_| {
            format!(
            "#!/bin/sh\ncase \"$1\" in\nlease-clock) printf '%s' '{}' ;;\ninspect) printf '%s' '{{\"locked\":false}}' ;;\n*) exit 1 ;;\nesac\n",
            clock_json()
        )
        })
    }
    fn assignment(c: &Config, claim: uuid::Uuid) -> Assignment {
        decode(json!({"id":uuid::Uuid::from_u128(10),"claimId":claim,"leaseId":uuid::Uuid::from_u128(11),
            "memberId":uuid::Uuid::from_u128(12),"domainId":uuid::Uuid::from_u128(13),"sequence":0,"closed":false,
            "image":c.inventory[0].image,"resources":{"cpu":1,"memoryMiB":1024,"diskGiB":4},
            "capabilities":["command","files"],"requiredCapabilities":["command"],
            "lease":{"state":"provisioning","revision":1,"expiresAt":101.0,"controllerNow":100.0},
            "stopRequested":false}).to_string().as_bytes()).unwrap()
    }
    /// Mirrors the controller's receipt rules that matter to the satellite.
    struct Wire {
        a: Assignment,
        requests: Vec<(&'static str, Value)>,
        lose: bool,
        cancel: bool,
        delay: Duration,
        claim_null: bool,
    }
    impl Controller for Wire {
        fn request(&mut self, route: LeaseRoute, body: Value) -> Result<Value> {
            let name = match route {
                LeaseRoute::Claim => "claim",
                LeaseRoute::Report => "report",
                LeaseRoute::Assignments => "assignments",
            };
            self.requests.push((name, body.clone()));
            std::thread::sleep(self.delay);
            if self.lose {
                return Err("lost reply");
            }
            match route {
                LeaseRoute::Claim if self.claim_null => Ok(json!({"assignment":null})),
                LeaseRoute::Claim => Ok(json!({"assignment":self.a})),
                LeaseRoute::Report => {
                    let r = &body["receipt"];
                    // No cleanup evidence while active; a failure ends the lease.
                    let ends = self.cancel || !r["failure"].is_null();
                    if !ends {
                        assert_eq!(r["cleanup"], "pending");
                        assert_eq!(r["storageRemoved"], false);
                    }
                    if r["runtimeState"] == "stopped" {
                        assert!(!r["failure"].is_null());
                    }
                    let complete = r["cleanup"] == "complete";
                    if complete {
                        assert!(r["executionStopped"] == true && r["credentialsErased"] == true);
                    }
                    Ok(json!({"assignmentId":self.a.id,"sequence":body["sequence"],
                    "lease":{"state":if ends {"failed"} else {"provisioning"},"revision":2,
                        "expiresAt":200.0,"controllerNow":100.0},
                    "stopRequested":ends,"released":complete}))
                }
                _ => Err("unexpected route"),
            }
        }
    }
    fn wire(a: Assignment) -> Wire {
        Wire {
            a,
            requests: vec![],
            lose: false,
            cancel: false,
            delay: Duration::ZERO,
            claim_null: false,
        }
    }
    #[test]
    fn claim_reply_loss_replays_across_restart_and_never_changes_identity() {
        let (_tmp, c) = fixture();
        let mut s = Satellite::open_preflighted(c.clone()).unwrap();
        let mut w = wire(assignment(&c, s.state.claim_id));
        w.lose = true;
        assert!(s.run_once(&mut w).is_err());
        let first = w.requests[0].clone();
        drop(s);
        let mut s = Satellite::open_preflighted(c.clone()).unwrap();
        assert!(s.run_once(&mut w).is_err());
        assert_eq!(first, w.requests[1]);
        drop(s);
        let mut changed = c.clone();
        changed.binding.generation += 1;
        assert!(Satellite::open_preflighted(changed).is_err());
        let mut changed = c;
        changed.inventory[0].image.digest = "sha256:wrong".into();
        assert!(Satellite::open_preflighted(changed).is_err());
    }
    #[test]
    fn idle_claim_does_not_age_a_later_assignment() {
        let (_tmp, c) = fixture();
        let mut s = Satellite::open_preflighted(c.clone()).unwrap();
        let mut a = assignment(&c, s.state.claim_id);
        a.resources.cpu = 3; // declined after recording, so no launch is attempted
        let mut w = wire(a);
        w.claim_null = true;
        s.run_once(&mut w).unwrap();
        std::thread::sleep(Duration::from_millis(1200));
        w.claim_null = false;
        let before = clock::now().as_secs_f64();
        assert!(s.run_once(&mut w).is_err());
        assert!(s.state.assignment.is_some() && !s.state.launch_intent);
        assert!(
            s.state.deadline >= before + 0.99,
            "idle time aged the deadline"
        );
        assert_eq!(w.requests[0], w.requests[1]);
    }
    fn seeded(c: &Config) -> Satellite {
        let mut s = Satellite::open_preflighted(c.clone()).unwrap();
        s.state.assignment = Some(assignment(c, s.state.claim_id));
        s.state.revision = 1;
        s.state.boot_session_id = boot_id();
        s.state.deadline = clock::now().as_secs_f64() + 100.0;
        s.save().unwrap();
        s
    }
    #[test]
    fn pending_report_replayed_exactly_after_loss_and_restart() {
        let (_tmp, c) = fixture();
        let mut s = seeded(&c);
        let mut w = wire(s.assignment().unwrap().clone());
        w.lose = true;
        assert!(s.report(&mut w).is_err());
        let original = w.requests[0].clone();
        drop(s);
        let mut s = Satellite::open_preflighted(c).unwrap();
        w.lose = false;
        w.cancel = true;
        s.report(&mut w).unwrap();
        assert_eq!(original, w.requests[1]);
        assert_eq!(s.state.sequence, 1);
        assert!(s.state.fenced);
        assert!(s.state.terminal);
    }
    #[test]
    fn expired_deadline_wins_a_newer_revision_and_network_latency() {
        let (_tmp, c) = fixture();
        let mut s = seeded(&c);
        let mut w = wire(s.assignment().unwrap().clone());
        s.state.deadline = clock::now().as_secs_f64() + 0.01;
        w.delay = Duration::from_millis(20);
        s.report(&mut w).unwrap();
        assert!(s.state.fenced);
        assert_eq!(s.state.revision, 1);
        s.state.deadline = clock::now().as_secs_f64() + 100.0;
        s.report(&mut w).unwrap();
        assert!(s.state.fenced);
    }
    #[test]
    fn uncertain_launch_never_prepares_or_runs_and_preserves_unrelated_directory() {
        let (tmp, c) = fixture();
        let mut s = seeded(&c);
        let unrelated = tmp.path().join("unrelated");
        std::fs::create_dir(&unrelated).unwrap();
        std::fs::write(unrelated.join("keep"), b"untouched").unwrap();
        s.state.launch_intent = true;
        s.save().unwrap();
        drop(s);
        let mut s = Satellite::open_preflighted(c).unwrap();
        let mut w = wire(s.assignment().unwrap().clone());
        assert!(s.run_once(&mut w).is_err());
        assert!(s.state.fenced && !s.state.stopped && !s.state.cleaned);
        assert!(!s.config.state.join("workspace").exists());
        assert_eq!(std::fs::read(unrelated.join("keep")).unwrap(), b"untouched");
        // The recovered report keeps runtime unknown and claims no cleanup evidence.
        for (_, r) in &w.requests {
            assert_eq!(r["receipt"]["runtimeState"], "unknown");
            assert_eq!(r["receipt"]["executionStopped"], false);
            assert_ne!(r["receipt"]["cleanup"], "complete");
        }
        assert!(s.run_once(&mut w).is_err());
        assert!(!s.state.released);
    }
    #[test]
    fn resources_images_and_local_artifacts_fail_closed() {
        let (_tmp, c) = fixture();
        let s = Satellite::open_preflighted(c.clone()).unwrap();
        let mut a = assignment(&c, s.state.claim_id);
        a.resources.cpu = 3;
        assert!(s.validate_assignment(&a).is_err());
        a.resources.cpu = 1;
        a.resources.disk_gi_b = 2; // below the native headless minimum
        assert!(s.validate_assignment(&a).is_err());
        a.resources.disk_gi_b = 4;
        a.image.digest = "sha256:wrong".into();
        assert!(s.validate_assignment(&a).is_err());
        a.image = c.inventory[0].image.clone();
        a.claim_id = uuid::Uuid::nil();
        assert!(s.check_identity(&a).is_err());
        let link = c.state.join("linked.raw");
        symlink(&c.inventory[0].path, &link).unwrap();
        assert!(hash_file(&link).is_err());
        let mut bad = c.clone();
        bad.helper_sha256 = "wrong".into();
        assert!(Satellite::open(bad).is_err());
        let mut nested = c.clone();
        nested.identity = c.state.join("identity");
        assert!(validate_local(&nested).is_err());
        validate_local(&c).unwrap();
        std::fs::set_permissions(&c.inventory[0].path, std::fs::Permissions::from_mode(0o600))
            .unwrap();
        assert!(validate_local(&c).is_err());
        assert!(Satellite::open(c).is_err());
    }
    #[test]
    fn declined_assignment_releases_without_any_local_effect() {
        let (_tmp, c) = fixture();
        let mut s = Satellite::open_preflighted(c.clone()).unwrap();
        let mut a = assignment(&c, s.state.claim_id);
        a.image.digest = "sha256:".to_string() + &"0".repeat(64);
        let mut w = wire(a);
        assert_eq!(
            s.run_once(&mut w).unwrap_err(),
            "assignment image not installed; declined"
        );
        assert!(s.state.released && !s.state.launch_intent);
        assert!(!c.state.join("workspace").exists());
        let (_, r) = w.requests.last().unwrap();
        assert_eq!(r["receipt"]["failure"], "provisioning");
        assert_eq!(r["receipt"]["cleanup"], "complete");
        // A released journal starts a fresh claim identity.
        let old = s.state.claim_id;
        w.claim_null = true;
        s.run_once(&mut w).unwrap();
        assert_ne!(s.state.claim_id, old);
        assert!(s.state.assignment.is_none());
    }
    #[test]
    fn existing_workspace_cannot_be_declined() {
        let (_tmp, c) = fixture();
        let mut s = seeded(&c);
        s.state.deadline = 0.0;
        s.save().unwrap();
        s.dir.workspace().unwrap();
        let mut w = wire(s.assignment().unwrap().clone());
        assert_eq!(
            s.run_once(&mut w).unwrap_err(),
            "unreconciled workspace; hold"
        );
        assert!(w.requests.is_empty() && !s.state.cleaned);
    }
    // Stop proof depends on the host lsof; the satellite's supported host is macOS.
    #[cfg(target_os = "macos")]
    #[test]
    fn fake_subprocess_prepare_clock_run_and_stop_cleanup() {
        fake_lifecycle(false);
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn fake_subprocess_disconnect_past_deadline_stops_then_recovers_cleanup() {
        fake_lifecycle(true);
    }
    #[cfg(target_os = "macos")]
    fn fake_lifecycle(disconnected: bool) {
        let (_tmp, c) = fixture_with(|m| {
            let m = m.display();
            format!("#!/bin/sh\ncase \"$1\" in\nlease-clock) printf '%s' '{}' ;;\nprepare) cat >/dev/null; mkdir -m 700 -p '{m}'; printf x >'{m}/disk.img' ;;\nrun) while [ ! -f '{m}/power-off.request' ]; do sleep 0.01; done ;;\ninspect) printf '%s' '{{\"locked\":false}}' ;;\nesac\n",
            clock_json())
        });
        let mut s = seeded(&c);
        let mut w = wire(s.assignment().unwrap().clone());
        w.cancel = !disconnected;
        w.lose = disconnected;
        if disconnected {
            s.state.deadline = clock::now().as_secs_f64() + 2.0;
            s.save().unwrap();
        }
        let result = s.run_once(&mut w);
        if disconnected {
            assert!(result.is_err());
            assert!(s.state.fenced && s.state.stopped);
            assert!(!s.state.cleaned && !s.state.released);
            assert!(c.state.join("workspace").exists());
            // Durable stop proof lets recovery finish once the controller is reachable.
            drop(s);
            let mut s = Satellite::open_preflighted(c.clone()).unwrap();
            w.lose = false;
            s.run_once(&mut w).unwrap();
            assert!(s.state.cleaned && s.state.released);
        } else {
            result.unwrap();
            assert!(s.state.stopped && s.state.cleaned && s.state.released);
        }
        assert!(!c.state.join("workspace").exists());
        for (_, r) in &w.requests {
            if let Some(receipt) = r.get("receipt") {
                assert_eq!(
                    receipt["ready"],
                    json!({"command":false,"pty":false,"files":false})
                );
            }
        }
    }
    #[test]
    fn cleanup_report_reply_loss_restarts_without_runtime_or_storage() {
        let (_tmp, c) = fixture();
        let mut s = seeded(&c);
        s.state.launch_intent = true;
        s.state.fenced = true;
        s.state.prepared = true;
        s.state.stopped = true;
        s.state.cleaning = true;
        s.state.cleaned = true;
        s.state.terminal = true;
        s.save().unwrap();
        let mut w = wire(s.assignment().unwrap().clone());
        w.cancel = true;
        w.lose = true;
        assert!(s.run_once(&mut w).is_err());
        let pending = w.requests[0].clone();
        drop(s);
        let mut s = Satellite::open_preflighted(c).unwrap();
        w.lose = false;
        s.run_once(&mut w).unwrap();
        assert_eq!(pending, w.requests[1]);
        assert!(s.state.released);
    }
    #[test]
    fn interrupted_deletion_resumes_only_after_durable_intent() {
        let (_tmp, c) = fixture();
        let mut s = seeded(&c);
        s.state.launch_intent = true;
        s.state.fenced = true;
        s.state.stopped = true;
        s.state.terminal = true;
        s.state.cleaning = true;
        s.save().unwrap();
        // The workspace was fully removed before the crash recorded completion.
        let mut w = wire(s.assignment().unwrap().clone());
        w.cancel = true;
        s.run_once(&mut w).unwrap();
        assert!(s.state.cleaned && s.state.released);
    }
    #[test]
    fn held_runtime_lock_cannot_prove_stop() {
        let (_tmp, c) = fixture_with(|_| "#!/bin/sh\nprintf '%s' '{\"locked\":true}'\n".into());
        let s = seeded(&c);
        std::fs::create_dir_all(s.machine().unwrap()).unwrap();
        let mut child = Command::new("/usr/bin/true").spawn().unwrap();
        child.wait().unwrap();
        assert!(!s.prove_stopped(Some(&mut child)).unwrap());
        assert!(!s.state.cleaned);
    }
    #[test]
    fn cleanup_never_follows_a_symlink_into_unrelated_storage() {
        let (tmp, c) = fixture();
        let s = Satellite::open_preflighted(c.clone()).unwrap();
        s.dir.workspace().unwrap();
        let other = tmp.path().join("other");
        std::fs::create_dir(&other).unwrap();
        std::fs::write(other.join("keep"), b"retained").unwrap();
        symlink(&other, c.state.join("workspace/alias")).unwrap();
        s.dir.cleanup_workspace(false).unwrap();
        assert_eq!(std::fs::read(other.join("keep")).unwrap(), b"retained");
        // Without durable deletion intent, an absent workspace is not cleanup evidence.
        assert!(s.dir.cleanup_workspace(false).is_err());
    }
    #[test]
    fn disconnect_cannot_extend_deadline_or_assert_cleanup() {
        let (_tmp, c) = fixture();
        let mut s = seeded(&c);
        let mut w = wire(s.assignment().unwrap().clone());
        w.lose = true;
        let old = s.state.deadline;
        assert!(s.report(&mut w).is_err());
        assert_eq!(s.state.deadline, old);
        assert!(!s.state.cleaned && !s.state.stopped);
    }
}
