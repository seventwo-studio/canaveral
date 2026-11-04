//! Persisted controller lease deadlines. No runtime/provider is started here.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use uuid::Uuid;

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
static TEMPORARY: AtomicU64 = AtomicU64::new(0);

/// The caller must provide wall time and a suspend-aware monotonic clock.
#[derive(Clone, Copy)]
pub struct Clock {
    pub wall: f64,
    pub monotonic: f64,
}
impl Clock {
    fn validate(self) -> Result<Self> {
        if [self.wall, self.monotonic]
            .iter()
            .any(|v| !v.is_finite() || *v < 0.0)
        {
            return Err("Invalid execution clock".into());
        }
        Ok(self)
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    machine: Value,
    received_at: f64,
    fenced: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    execution_started: Option<bool>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    retired: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cleanup_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Lease {
    id: String,
    revision: u64,
    state: String,
    authorization_deadline: f64,
    controller_now: f64,
}
fn identifier(value: &str) -> Result<String> {
    Ok(Uuid::parse_str(value)?.hyphenated().to_string())
}
fn machine_id(machine: &Value) -> Result<String> {
    identifier(
        machine
            .get("id")
            .and_then(Value::as_str)
            .ok_or("Missing machine UUID")?,
    )
}
fn lease(machine: &Value) -> Result<Lease> {
    let lease: Lease =
        serde_json::from_value(machine.get("lease").cloned().ok_or("Missing lease")?)?;
    identifier(&lease.id)?;
    if lease.revision == 0
        || lease.revision > 9_007_199_254_740_991
        || [lease.authorization_deadline, lease.controller_now]
            .iter()
            .any(|v| !v.is_finite() || *v < 0.0 || *v > 9_007_199_254_740_991.0)
    {
        return Err("Invalid lease deadline report".into());
    }
    Ok(lease)
}
fn options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}
fn publish(path: &Path, records: &BTreeMap<String, Record>) -> Result<()> {
    let parent = path.parent().ok_or("Missing journal directory")?;
    let (temporary, mut file) = loop {
        let name = parent.join(format!(
            ".lease-{}-{}.tmp",
            std::process::id(),
            TEMPORARY.fetch_add(1, Ordering::Relaxed)
        ));
        match options().create_new(true).open(&name) {
            Ok(file) => break (name, file),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    };
    let result = (|| -> Result<()> {
        serde_json::to_writer(&mut file, records)?;
        file.flush()?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        #[cfg(unix)]
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    let _ = fs::remove_file(&temporary);
    result
}

#[derive(Debug, Serialize)]
pub struct Authorization {
    #[serde(rename = "leaseID")]
    pub lease_id: String,
    pub revision: u64,
    #[serde(rename = "remainingSeconds")]
    pub remaining_seconds: f64,
    pub fenced: bool,
}

/// Owns agent.lock for its lifetime. Callers serialize mutations through &mut self.
/// Publication failure poisons this instance; it cannot grant execution afterward.
pub struct LeaseGuard {
    path: PathBuf,
    _lock: File,
    records: BTreeMap<String, Record>,
    deadlines: BTreeMap<String, f64>,
    history_known: bool,
    healthy: bool,
}
impl LeaseGuard {
    pub fn open(state: &Path, clock: Clock) -> Result<Self> {
        let clock = clock.validate()?;
        let mut directory = fs::DirBuilder::new();
        directory.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            directory.mode(0o700);
        }
        directory.create(state)?;
        let lock = options()
            .read(true)
            .create(true)
            .truncate(false)
            .open(state.join("agent.lock"))?;
        lock.try_lock()?;
        let path = state.join("lease-execution.json");
        let history_known = path.try_exists()? || !state.join("identity.json").try_exists()?;
        let mut records: BTreeMap<String, Record> = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(error) => return Err(error.into()),
        };
        let mut deadlines = BTreeMap::new();
        let mut changed = false;
        for (id, record) in &mut records {
            if identifier(id)? != *id
                || machine_id(&record.machine)? != *id
                || !record.received_at.is_finite()
                || record.received_at < 0.0
            {
                return Err("Invalid persisted lease scope".into());
            }
            let report = lease(&record.machine)?;
            let remaining = report.authorization_deadline - clock.wall - 5.0;
            if clock.wall < record.received_at - 5.0 || remaining <= 0.0 {
                changed |= !record.fenced;
                record.fenced = true;
            }
            deadlines.insert(id.clone(), clock.monotonic + remaining.max(0.0));
        }
        let mut guard = Self {
            path,
            _lock: lock,
            records,
            deadlines,
            history_known,
            healthy: true,
        };
        if changed {
            guard.save()?;
        }
        Ok(guard)
    }
    fn check(&self) -> Result<()> {
        if self.healthy {
            Ok(())
        } else {
            Err("Lease journal publication is unconfirmed; execution is fenced".into())
        }
    }
    fn save(&mut self) -> Result<()> {
        if let Err(error) = publish(&self.path, &self.records) {
            self.healthy = false;
            for record in self.records.values_mut() {
                record.fenced = true;
            }
            return Err(error);
        }
        Ok(())
    }
    pub fn observe(&mut self, machines: &[Value], round_trip: f64, clock: Clock) -> Result<()> {
        self.check()?;
        let clock = clock.validate()?;
        if !round_trip.is_finite() || round_trip < 0.0 {
            return Err("Invalid controller round trip".into());
        }
        // Validate the complete response before changing authorization state.
        for machine in machines {
            machine_id(machine)?;
            if !machine.get("lease").is_none_or(Value::is_null) {
                lease(machine)?;
            }
        }
        let mut changed = self.records.is_empty()
            && machines
                .iter()
                .all(|m| m.get("lease").is_none_or(Value::is_null))
            && (!self.history_known || !self.path.try_exists()?);
        let mut seen = BTreeSet::new();
        for machine in machines {
            let id = machine_id(machine)?;
            seen.insert(id.clone());
            if machine.get("lease").is_none_or(Value::is_null) {
                if let Some(previous) = self.records.get_mut(&id) {
                    previous.fenced = true;
                    changed = true;
                }
                continue;
            }
            let report = lease(machine)?;
            let previous = self.records.get(&id).cloned();
            if let Some(previous) = &previous {
                if lease(&previous.machine)?.id != report.id {
                    self.records
                        .get_mut(&id)
                        .ok_or("Missing prior lease")?
                        .fenced = true;
                    self.save()?;
                    return Err("Machine lease ownership changed".into());
                }
                if previous.retired {
                    continue;
                }
                if report.revision < lease(&previous.machine)?.revision {
                    continue;
                }
            }
            let mut fenced = previous
                .as_ref()
                .is_some_and(|p| p.fenced || clock.monotonic >= self.deadlines[&id]);
            fenced |= !["provisioning", "ready"].contains(&report.state.as_str())
                || (clock.wall - report.controller_now).abs() > 5.0 + round_trip;
            let mut deadline = clock.monotonic
                + (report.authorization_deadline - report.controller_now - round_trip).max(0.0);
            if let Some(previous) = &previous {
                if report.authorization_deadline <= lease(&previous.machine)?.authorization_deadline
                {
                    deadline = deadline.min(self.deadlines[&id]);
                }
            }
            fenced |= deadline <= clock.monotonic;
            self.records.insert(
                id.clone(),
                Record {
                    machine: machine.clone(),
                    received_at: clock.wall,
                    fenced,
                    execution_started: Some(
                        previous
                            .as_ref()
                            .map_or(!self.history_known, |p| p.execution_started.unwrap_or(true)),
                    ),
                    retired: false,
                    cleanup_id: None,
                },
            );
            self.deadlines.insert(id, deadline);
            changed = true;
        }
        for (id, record) in &mut self.records {
            if !record.retired && !seen.contains(id) {
                record.fenced = true;
                changed = true;
            }
        }
        if changed {
            self.save()?;
            self.history_known = true;
        }
        Ok(())
    }
    pub fn allowed(&mut self, id: &str, clock: Clock) -> Result<bool> {
        self.check()?;
        let clock = clock.validate()?;
        let Some(record) = self.records.get_mut(id) else {
            return Ok(true);
        };
        if !record.fenced && clock.monotonic >= self.deadlines[id] {
            record.fenced = true;
            self.save()?;
        }
        Ok(!self.records[id].fenced)
    }
    pub fn assignments(&mut self, current: &[Value], clock: Clock) -> Result<Vec<Value>> {
        self.check()?;
        let mut result = BTreeMap::new();
        for machine in current {
            result.insert(machine_id(machine)?, machine.clone());
        }
        for (id, record) in self.records.clone() {
            if record.retired {
                result.remove(&id);
                continue;
            }
            let machine = result.entry(id.clone()).or_insert(record.machine);
            if !self.allowed(&id, clock)? {
                machine["desired"] = Value::from("stopped");
                machine["leaseFenced"] = Value::from(true);
            }
        }
        Ok(result.into_values().collect())
    }
    pub fn fenced_machines(&mut self, clock: Clock) -> Result<BTreeSet<String>> {
        let mut result = BTreeSet::new();
        self.check()?;
        for (id, record) in self.records.clone() {
            if !record.retired && !self.allowed(&id, clock)? {
                result.insert(id);
            }
        }
        Ok(result)
    }
    pub fn begin_execution(&mut self, id: &str, lease_id: &str, clock: Clock) -> Result<()> {
        let id = identifier(id)?;
        self.check()?;
        if !self.records.contains_key(&id)
            || lease(&self.records[&id].machine)?.id != identifier(lease_id)?
            || !self.allowed(&id, clock)?
        {
            return Err("Leased execution is not authorized".into());
        }
        let record = self.records.get_mut(&id).ok_or("Missing lease")?;
        if record.execution_started != Some(true) {
            record.execution_started = Some(true);
            self.save()?;
        }
        Ok(())
    }
    pub fn never_started(&self, id: &str, lease_id: &str) -> Result<bool> {
        self.check()?;
        let lease_id = identifier(lease_id)?;
        Ok(self.records.get(&identifier(id)?).is_some_and(|r| {
            lease(&r.machine).is_ok_and(|l| l.id == lease_id) && r.execution_started == Some(false)
        }))
    }
    pub fn retire(&mut self, id: &str, lease_id: &str, cleanup_id: &str) -> Result<()> {
        self.check()?;
        let id = identifier(id)?;
        let lease_id = identifier(lease_id)?;
        let cleanup_id = identifier(cleanup_id)?;
        let record = self.records.get_mut(&id).ok_or("Missing lease")?;
        if lease(&record.machine)?.id != lease_id
            || record
                .machine
                .pointer("/leaseCleanup/id")
                .and_then(Value::as_str)
                != Some(cleanup_id.as_str())
            || record
                .machine
                .pointer("/leaseCleanup/leaseId")
                .and_then(Value::as_str)
                != Some(lease_id.as_str())
        {
            return Err("Cleanup acknowledgement has different durable ownership".into());
        }
        record.fenced = true;
        record.retired = true;
        record.cleanup_id = Some(cleanup_id);
        self.save()
    }
    pub fn authorization(
        &mut self,
        id: &str,
        lease_id: &str,
        clock: Clock,
    ) -> Result<Authorization> {
        self.check()?;
        let id = identifier(id)?;
        let report = lease(
            &self
                .records
                .get(&id)
                .ok_or("Missing pinned lease deadline")?
                .machine,
        )?;
        if report.id != identifier(lease_id)? {
            return Err("Native execution requires the pinned lease deadline".into());
        }
        let allowed = self.allowed(&id, clock)?;
        Ok(Authorization {
            lease_id: lease_id.to_owned(),
            revision: report.revision,
            remaining_seconds: if allowed {
                (self.deadlines[&id] - clock.monotonic).max(0.0)
            } else {
                0.0
            },
            fenced: !allowed,
        })
    }
}
