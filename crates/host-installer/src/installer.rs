use crate::pins::{self, Pin};
use flate2::bufread::GzDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{self, Read};

pub(crate) const UNIT_NAME: &str = "canaveral-containerd.service";
pub(crate) const UNIT: &str = "/etc/systemd/system/canaveral-containerd.service";
const CONFIG: &str = "/etc/canaveral-containerd/config.toml";
pub(crate) const SOCKET: &str = "/run/canaveral-containerd/containerd.sock";
const STATE: &str = "/var/lib/canaveral-containerd";
const RECEIPT: &str = "/var/lib/canaveral-host-installer/receipts/containerd.json";
const PENDING: &str = "/var/lib/canaveral-host-installer/receipts/containerd.pending.json";
const KIND: &str = "canaveral-host-installer-receipt";
pub(crate) const BINARIES: [&str; 4] = ["containerd", "containerd-shim-runc-v2", "ctr", "runc"];
const MAX_BINARY: usize = 64 * 1024 * 1024;
const MAX_DOCUMENT: usize = 64 * 1024;
const UNIT_DIRS: [&str; 12] = [
    "/etc/systemd/system.control",
    "/run/systemd/system.control",
    "/run/systemd/transient",
    "/run/systemd/generator.early",
    "/etc/systemd/system",
    "/etc/systemd/system.attached",
    "/run/systemd/system",
    "/run/systemd/system.attached",
    "/run/systemd/generator",
    "/usr/local/lib/systemd/system",
    "/usr/lib/systemd/system",
    "/lib/systemd/system",
];

#[derive(Debug)]
pub(crate) struct Failure {
    code: &'static str,
    detail: String,
}

impl Failure {
    pub(crate) fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

pub(crate) type Result<T> = std::result::Result<T, Failure>;

#[derive(Debug, Default)]
pub(crate) struct Unit {
    pub loaded: bool,
    pub fragment: String,
    pub drop_ins: bool,
    pub active: bool,
    pub settled: bool,
    pub pid: u32,
}

/// The production implementation binds every effect to the local Linux host.
/// Fixture implementations can substitute files, downloads and service state.
pub(crate) trait Host {
    type Lock;
    fn authorize(&self) -> Result<()>;
    fn lock(&self) -> Result<Self::Lock>;
    fn exists(&self, path: &str) -> Result<bool>;
    fn check_directory(&self, path: &str, private: bool) -> Result<()>;
    fn check_bin(&self, path: &str) -> Result<()>;
    fn read(&self, path: &str, mode: u32, limit: usize) -> Result<Option<Vec<u8>>>;
    fn write(&self, path: &str, mode: u32, bytes: &[u8]) -> Result<()>;
    fn unlink(&self, path: &str) -> Result<()>;
    fn fetch(&self, pins: &[Pin; 2]) -> Result<[Vec<u8>; 2]>;
    fn unit(&self, name: &str) -> Result<Unit>;
    fn systemctl(&self, args: &[&str]) -> Result<()>;
    fn is_active(&self) -> Result<bool>;
    fn owns_socket(&self, pid: u32, executable: &str) -> Result<bool>;
    fn ctr(&self, executable: &str, args: &[&str]) -> Result<String>;
    fn now(&self) -> Result<u64>;
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct Asset {
    name: String,
    version: String,
    sha256: String,
}

impl From<&Pin> for Asset {
    fn from(pin: &Pin) -> Self {
        Self {
            name: pin.name.into(),
            version: pin.version.into(),
            sha256: pin.sha256.into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct FileRecord {
    path: String,
    sha256: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    #[serde(rename = "type")]
    kind: String,
    version: u32,
    component: String,
    installed_at: u64,
    assets: [Asset; 2],
    files: Vec<FileRecord>,
    unit: String,
    socket: String,
}

fn bin_dir(version: &str) -> String {
    format!("/opt/canaveral-containerd/{version}/bin")
}

fn bin(version: &str, name: &str) -> String {
    format!("{}/{name}", bin_dir(version))
}

impl Receipt {
    fn version(&self) -> &str {
        &self.assets[0].version
    }

    fn valid(&self) -> bool {
        let valid_version = |version: &str| {
            version.len() <= 32
                && version.split('.').count() == 3
                && version
                    .split('.')
                    .all(|n| !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit()))
        };
        let valid_digest = |digest: &str| {
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        };
        if self.kind != KIND
            || self.version != 1
            || self.component != "containerd"
            || self.unit != UNIT
            || self.socket != SOCKET
            || self.installed_at >= (1 << 53)
            || self.assets[0].name != "containerd"
            || self.assets[1].name != "runc"
            || self
                .assets
                .iter()
                .any(|a| !valid_version(&a.version) || !valid_digest(&a.sha256))
            || self.files.len() != BINARIES.len() + 2
        {
            return false;
        }
        let mut paths: BTreeSet<_> = BINARIES
            .iter()
            .map(|name| bin(self.version(), name))
            .collect();
        paths.extend([CONFIG.into(), UNIT.into()]);
        self.files
            .iter()
            .all(|file| paths.remove(&file.path) && valid_digest(&file.sha256))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Pending {
    previous: Option<Receipt>,
    next: Option<Receipt>,
}

impl Pending {
    fn receipts(&self) -> impl Iterator<Item = &Receipt> {
        self.previous.iter().chain(&self.next)
    }

    fn valid(&self) -> bool {
        self.receipts().next().is_some() && self.receipts().all(Receipt::valid)
    }
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn config(version: &str) -> String {
    format!(
        "version = 3\nroot = \"{STATE}\"\nstate = \"/run/canaveral-containerd\"\ntemp = \"{STATE}/tmp\"\n\
         disabled_plugins = [\n\
         \"io.containerd.grpc.v1.cri\", \"io.containerd.cri.v1.images\", \"io.containerd.cri.v1.runtime\",\n\
         \"io.containerd.internal.v1.opt\", \"io.containerd.nri.v1.nri\",\n\
         ]\n\
         [grpc]\naddress = \"{SOCKET}\"\nuid = 0\ngid = 0\n\
         [plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runc.options]\nBinaryName = \"{}\"\n",
        bin(version, "runc")
    )
}

fn unit_file(version: &str) -> String {
    format!(
        "[Unit]\nDescription=Canaveral containerd\nAfter=local-fs.target\n\n\
         [Service]\nType=notify\nExecStart={} --config {CONFIG}\n\
         Environment=PATH={}\nUMask=0077\n\
         RuntimeDirectory=canaveral-containerd\nRuntimeDirectoryMode=0700\n\
         StateDirectory=canaveral-containerd\nStateDirectoryMode=0700\n\
         Delegate=yes\nKillMode=process\nRestart=on-failure\nTimeoutStartSec=60\nTimeoutStopSec=60\n\n\
         [Install]\nWantedBy=multi-user.target\n",
        bin(version, "containerd"), bin_dir(version)
    )
}

fn mode(path: &str) -> u32 {
    if [CONFIG, UNIT].contains(&path) {
        0o644
    } else {
        0o755
    }
}

fn read_error(error: io::Error) -> Failure {
    Failure::new("invalid_archive", error.to_string())
}

fn extract(bytes: &[u8]) -> Result<BTreeMap<String, Vec<u8>>> {
    let mut archive = tar::Archive::new(GzDecoder::new(bytes));
    let mut seen = BTreeSet::new();
    let mut files = BTreeMap::new();
    for entry in archive.entries().map_err(read_error)?.raw(true) {
        let mut entry = entry.map_err(read_error)?;
        let path = entry.path_bytes();
        let kind = entry.header().entry_type();
        let permissions = entry.header().mode().map_err(read_error)?;
        let size = entry.size();
        let regular = [
            b"bin/containerd".as_slice(),
            b"bin/containerd-shim-runc-v2",
            b"bin/containerd-stress",
            b"bin/ctr",
        ]
        .contains(&path.as_ref());
        let directory = path.as_ref() == b"bin/" && kind.is_dir() && size == 0;
        let binary = regular && kind.is_file() && size > 0 && size <= MAX_BINARY as u64;
        if permissions & 0o7000 != 0 || !(directory || binary) || !seen.insert(path.into_owned()) {
            return Err(Failure::new(
                "invalid_archive",
                "Unexpected, unsafe or duplicate tar entry",
            ));
        }
        if directory {
            continue;
        }
        let path = entry.path_bytes().into_owned();
        let name = std::str::from_utf8(&path[4..]).expect("checked the entry name");
        if name != "containerd-stress" {
            let mut contents = Vec::new();
            entry.read_to_end(&mut contents).map_err(read_error)?;
            if contents.len() as u64 != size {
                return Err(Failure::new("invalid_archive", "Truncated tar entry"));
            }
            files.insert(name.into(), contents);
        }
    }
    if files.len() != 3 {
        return Err(Failure::new(
            "invalid_archive",
            "The archive is missing an expected binary",
        ));
    }
    // Consume the gzip footer and allow only tar's trailing zero padding.
    // An extra tar archive or gzip member is not part of this format.
    let mut gzip = archive.into_inner();
    let mut padding = Vec::new();
    gzip.by_ref()
        .take(10_241)
        .read_to_end(&mut padding)
        .map_err(read_error)?;
    if padding.is_empty()
        || padding.len() > 10_240
        || padding.iter().any(|b| *b != 0)
        || !gzip.into_inner().is_empty()
    {
        return Err(Failure::new(
            "invalid_archive",
            "Unexpected data after the tar entries",
        ));
    }
    Ok(files)
}

fn prepare(
    host: &impl Host,
    pins: &[Pin; 2],
    installed_at: u64,
) -> Result<(Receipt, BTreeMap<String, Vec<u8>>)> {
    let [archive, runc] = host.fetch(pins)?;
    for (pin, bytes) in pins.iter().zip([&archive, &runc]) {
        if bytes.len() != pin.bytes || sha256(bytes) != pin.sha256 {
            return Err(Failure::new(
                "asset_digest_mismatch",
                format!("Size or SHA-256 does not match {}", pin.name),
            ));
        }
    }
    let version = pins[0].version;
    let mut binaries = extract(&archive)?;
    binaries.insert("runc".into(), runc);
    let mut files: BTreeMap<_, _> = binaries
        .into_iter()
        .map(|(name, bytes)| (bin(version, &name), bytes))
        .collect();
    files.insert(CONFIG.into(), config(version).into_bytes());
    files.insert(UNIT.into(), unit_file(version).into_bytes());
    let receipt = Receipt {
        kind: KIND.into(),
        version: 1,
        component: "containerd".into(),
        installed_at,
        assets: pins.each_ref().map(Asset::from),
        files: files
            .iter()
            .map(|(path, bytes)| FileRecord {
                path: path.clone(),
                sha256: sha256(bytes),
            })
            .collect(),
        unit: UNIT.into(),
        socket: SOCKET.into(),
    };
    Ok((receipt, files))
}

fn document<T: for<'de> Deserialize<'de>>(host: &impl Host, path: &str) -> Result<Option<T>> {
    host.read(path, 0o644, MAX_DOCUMENT)?
        .map(|bytes| {
            serde_json::from_slice(&bytes)
                .map_err(|_| Failure::new("invalid_receipt", format!("Cannot parse {path}")))
        })
        .transpose()
}

fn publish(host: &impl Host, path: &str, value: &impl Serialize) -> Result<()> {
    let bytes = serde_json::to_vec(value)
        .map_err(|error| Failure::new("serialization_failed", error.to_string()))?;
    host.write(path, 0o644, &bytes)
}

fn receipt(host: &impl Host) -> Result<Option<Receipt>> {
    let receipt = document::<Receipt>(host, RECEIPT)?;
    if receipt.as_ref().is_some_and(|r| !r.valid()) {
        return Err(Failure::new(
            "invalid_receipt",
            "The receipt does not describe the fixed installation",
        ));
    }
    Ok(receipt)
}

fn foreign(host: &impl Host) -> Result<()> {
    for directory in [
        "/usr/sbin",
        "/usr/bin",
        "/sbin",
        "/bin",
        "/usr/local/sbin",
        "/usr/local/bin",
        "/snap/bin",
    ] {
        for name in [
            "containerd",
            "containerd-shim-runc-v2",
            "containerd-stress",
            "ctr",
            "runc",
            "dockerd",
            "docker",
            "k3s",
        ] {
            refuse_existing(host, &format!("{directory}/{name}"))?;
        }
    }
    for path in [
        "/run/containerd/containerd.sock",
        "/run/docker.sock",
        "/etc/containerd",
        "/run/k3s",
        "/opt/cni/bin",
    ] {
        refuse_existing(host, path)?;
    }
    for name in [
        "containerd.service",
        "docker.service",
        "docker.socket",
        "k3s.service",
        "k3s-agent.service",
    ] {
        for directory in UNIT_DIRS.into_iter().chain(["/run/systemd/generator.late"]) {
            refuse_existing(host, &format!("{directory}/{name}"))?;
        }
        if host.unit(name)?.loaded {
            return Err(Failure::new(
                "foreign_install",
                format!("The system manager already has {name}"),
            ));
        }
    }
    Ok(())
}

fn refuse_existing(host: &impl Host, path: &str) -> Result<()> {
    if host.exists(path)? {
        return Err(Failure::new(
            "foreign_install",
            format!("Existing path needs operator review: {path}"),
        ));
    }
    Ok(())
}

fn inspect_unit(host: &impl Host, owned: bool) -> Result<Unit> {
    for dir in UNIT_DIRS.into_iter().chain(["/run/systemd/generator.late"]) {
        if format!("{dir}/{UNIT_NAME}") != UNIT {
            refuse_existing(host, &format!("{dir}/{UNIT_NAME}"))?;
        }
        for name in [
            "canaveral-containerd.service.d",
            "canaveral-.service.d",
            "service.d",
        ] {
            refuse_existing(host, &format!("{dir}/{name}"))?;
        }
    }
    let unit = host.unit(UNIT_NAME)?;
    if unit.drop_ins || (unit.loaded && (!owned || unit.fragment != UNIT)) {
        return Err(Failure::new(
            "foreign_install",
            "The service definition or a drop-in is foreign",
        ));
    }
    if !unit.settled {
        return Err(Failure::new(
            "service_state_unknown",
            "The service is changing state",
        ));
    }
    Ok(unit)
}

fn file_digest(host: &impl Host, path: &str) -> Result<Option<String>> {
    Ok(host
        .read(path, mode(path), MAX_BINARY)?
        .as_deref()
        .map(sha256))
}

fn inspect_files(
    host: &impl Host,
    tx: &Pending,
    version: &str,
    recovering: bool,
) -> Result<BTreeMap<String, String>> {
    host.check_directory(STATE, true)?;
    host.check_directory("/run/canaveral-containerd", true)?;
    let mut expected: BTreeMap<String, BTreeSet<&str>> = BTreeMap::new();
    for version in std::iter::once(version).chain(tx.receipts().map(Receipt::version)) {
        host.check_bin(&bin_dir(version))?;
        for name in BINARIES {
            expected.entry(bin(version, name)).or_default();
        }
    }
    for path in [UNIT, CONFIG] {
        expected.entry(path.into()).or_default();
    }
    for record in tx.receipts().flat_map(|r| &r.files) {
        expected
            .entry(record.path.clone())
            .or_default()
            .insert(&record.sha256);
    }
    let mut disk = BTreeMap::new();
    for (path, digests) in expected {
        match file_digest(host, &path)? {
            Some(digest) if digests.contains(digest.as_str()) => {
                disk.insert(path, digest);
            }
            None if recovering || digests.is_empty() => {}
            _ => {
                return Err(Failure::new(
                    "ownership_mismatch",
                    format!("Missing, unowned or modified installation file: {path}"),
                ))
            }
        }
    }
    Ok(disk)
}

fn running<'a>(
    host: &impl Host,
    unit: &Unit,
    tx: &'a Pending,
    disk: &BTreeMap<String, String>,
) -> Result<Option<&'a Receipt>> {
    let socket = host.exists(SOCKET)?;
    if !socket && !unit.active {
        return Ok(None);
    }
    if socket && unit.active {
        for receipt in tx.next.iter().chain(&tx.previous) {
            if receipt
                .files
                .iter()
                .all(|file| disk.get(&file.path) == Some(&file.sha256))
                && host.owns_socket(unit.pid, &bin(receipt.version(), "containerd"))?
            {
                return Ok(Some(receipt));
            }
        }
    }
    Err(Failure::new(
        "unowned_socket",
        "The socket and running service could not be tied to the recorded installation",
    ))
}

fn idle(host: &impl Host, active: Option<&Receipt>, previously_checked: bool) -> Result<()> {
    let Some(receipt) = active else {
        if previously_checked {
            return Ok(());
        }
        return Err(Failure::new(
            "idle_unproven",
            "Start the verified service to establish that it has no tasks or containers",
        ));
    };
    let executable = bin(receipt.version(), "ctr");
    let query = |args: &[&str]| {
        host.ctr(&executable, args)
            .map_err(|error| Failure::new("idle_unproven", error.detail))
    };
    let namespaces = query(&["namespaces", "list", "--quiet"])?;
    for namespace in namespaces.lines() {
        if namespace.is_empty()
            || !namespace
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
        {
            return Err(Failure::new(
                "idle_unproven",
                "Invalid namespace returned by ctr",
            ));
        }
        for collection in ["tasks", "containers"] {
            if !query(&["--namespace", namespace, collection, "list", "--quiet"])?.is_empty() {
                return Err(Failure::new(
                    "runtime_in_use",
                    format!("The {namespace} namespace has {collection}"),
                ));
            }
        }
    }
    if query(&["namespaces", "list", "--quiet"])? != namespaces {
        return Err(Failure::new(
            "idle_unproven",
            "The namespace list changed during the idle check",
        ));
    }
    Ok(())
}

fn stop(host: &impl Host) -> Result<()> {
    host.systemctl(&["disable", "--now", UNIT_NAME])?;
    if host.is_active()? || host.exists(SOCKET)? {
        return Err(Failure::new(
            "service_state_unknown",
            "The service or socket remains after stopping",
        ));
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Operation {
    Plan,
    Install,
    Status,
    Remove,
}

impl Operation {
    fn name(self) -> &'static str {
        match self {
            Self::Plan => "plan",
            Self::Install => "install",
            Self::Status => "status",
            Self::Remove => "remove",
        }
    }
}

fn mutate(host: &impl Host, pins: &[Pin; 2], op: Operation) -> Result<&'static str> {
    host.authorize()?;
    let _lock = host.lock()?;
    foreign(host)?;
    let current = receipt(host)?;
    let pending = document::<Pending>(host, PENDING)?;
    if pending.as_ref().is_some_and(|tx| {
        !tx.valid()
            || (current != tx.previous && current != tx.next)
            || (tx.next.is_some() != (op == Operation::Install))
            || tx
                .next
                .as_ref()
                .is_some_and(|next| next.assets != pins.each_ref().map(Asset::from))
    }) {
        return Err(Failure::new(
            "recovery_required",
            "Retry the interrupted operation with the same installer release",
        ));
    }
    let mut tx = pending.clone().unwrap_or_else(|| Pending {
        previous: current.clone(),
        next: None,
    });
    let disk = inspect_files(host, &tx, pins[0].version, pending.is_some())?;
    let unit = inspect_unit(host, disk.contains_key(UNIT) || pending.is_some())?;
    let active = running(host, &unit, &tx, &disk)?.cloned();
    let active = active.as_ref();

    if op == Operation::Remove {
        let Some(previous) = tx.previous.as_ref() else {
            return Ok("absent");
        };
        idle(host, active, pending.is_some())?;
        if pending.is_none() {
            publish(host, PENDING, &tx)?;
        }
        if unit.loaded && disk.contains_key(UNIT) {
            stop(host)?;
        }
        for file in &previous.files {
            if disk.contains_key(&file.path) {
                host.unlink(&file.path)?;
            }
        }
        host.systemctl(&["daemon-reload"])?;
        host.unlink(RECEIPT)?;
        host.unlink(PENDING)?;
        return Ok("removed");
    }

    let assets = pins.each_ref().map(Asset::from);
    if pending.is_none() && current.as_ref().is_some_and(|r| r.assets == assets) {
        if active.is_none() {
            start(host, current.as_ref().expect("matching receipt"))?;
        }
        return Ok("installed");
    }
    if pending.is_none() && current.is_none() && host.exists(STATE)? {
        return Err(Failure::new(
            "foreign_install",
            format!("Inspect and move the existing state directory before installing: {STATE}"),
        ));
    }

    let upgrading = tx.previous.is_some();
    let stop_previous = upgrading && active == tx.previous.as_ref();
    if stop_previous || (upgrading && pending.is_none()) {
        idle(host, active, false)?;
    }
    let (next, files) = match &tx.next {
        Some(next)
            if next
                .files
                .iter()
                .all(|f| disk.get(&f.path) == Some(&f.sha256)) =>
        {
            (next.clone(), BTreeMap::new())
        }
        Some(expected) => {
            let (next, files) = prepare(host, pins, expected.installed_at)?;
            if expected != &next {
                return Err(Failure::new(
                    "recovery_required",
                    "Prepared files differ from the recorded transaction",
                ));
            }
            (next, files)
        }
        None => prepare(host, pins, host.now()?)?,
    };
    if stop_previous {
        idle(host, active, false)?;
    }
    if pending.is_none() {
        tx.next = Some(next.clone());
        publish(host, PENDING, &tx)?;
    }

    if stop_previous {
        stop(host)?;
    }
    // Publish the unit last among the files so a loaded unit always points
    // at complete binaries and config.
    for (path, contents) in files
        .iter()
        .filter(|(path, _)| path.as_str() != UNIT)
        .chain(files.get_key_value(UNIT))
    {
        if disk.get(path) != Some(&sha256(contents)) {
            host.write(path, mode(path), contents)?;
        }
    }
    if stop_previous || active != Some(&next) {
        start(host, &next)?;
    }
    if let Some(previous) = tx
        .previous
        .as_ref()
        .filter(|old| old.version() != next.version())
    {
        for file in &previous.files {
            if ![UNIT, CONFIG].contains(&file.path.as_str()) && disk.contains_key(&file.path) {
                host.unlink(&file.path)?;
            }
        }
    }
    publish(host, RECEIPT, &next)?;
    host.unlink(PENDING)?;
    Ok("installed")
}

fn start(host: &impl Host, receipt: &Receipt) -> Result<()> {
    host.systemctl(&["daemon-reload"])?;
    let unit = inspect_unit(host, true)?;
    if !unit.loaded || unit.active || host.exists(SOCKET)? {
        return Err(Failure::new(
            "service_state_unknown",
            "Could not confirm the new unit is loaded and stopped",
        ));
    }
    host.systemctl(&["enable", "--now", UNIT_NAME])?;
    host.check_directory("/run/canaveral-containerd", true)?;
    let unit = inspect_unit(host, true)?;
    if !unit.active
        || !host.is_active()?
        || !host.owns_socket(unit.pid, &bin(receipt.version(), "containerd"))?
    {
        return Err(Failure::new(
            "service_state_unknown",
            "Could not confirm the installed service and socket",
        ));
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileStatus {
    path: String,
    expected_sha256: String,
    actual_sha256: Option<String>,
    code: &'static str,
}

fn status(host: &impl Host) -> Result<serde_json::Value> {
    let receipt = receipt(host)?;
    let mut files = Vec::new();
    for file in receipt.iter().flat_map(|r| &r.files) {
        let (actual_sha256, code) = match file_digest(host, &file.path) {
            Ok(Some(digest)) if digest == file.sha256 => (Some(digest), "matches"),
            Ok(Some(digest)) => (Some(digest), "digest_mismatch"),
            Ok(None) => (None, "missing"),
            Err(_) => (None, "unreadable_or_unsafe"),
        };
        files.push(FileStatus {
            path: file.path.clone(),
            expected_sha256: file.sha256.clone(),
            actual_sha256,
            code,
        });
    }
    let pending = host.exists(PENDING)?;
    let unit_active = host.is_active().ok();
    let socket_present = host.exists(SOCKET).ok();
    let state = if pending {
        "recovery_required"
    } else if files.iter().any(|f| f.code != "matches") {
        "ownership_mismatch"
    } else {
        match (receipt.is_some(), unit_active, socket_present) {
            (true, Some(true), Some(true)) => "installed",
            (true, Some(false), Some(false)) => "inactive",
            (false, Some(false), Some(false)) => "absent",
            _ => "unknown",
        }
    };
    Ok(
        serde_json::json!({ "code": state, "receipt": receipt, "files": files, "unitActive": unit_active, "socketPresent": socket_present }),
    )
}

fn operation(host: &impl Host, op: Operation, arch: &str) -> Result<serde_json::Value> {
    let pins = pins::for_arch(arch).ok_or_else(|| {
        Failure::new(
            "unsupported_arch",
            "Supported architectures are amd64 and arm64",
        )
    })?;
    match op {
        Operation::Plan => Ok(serde_json::json!({
            "code": "planned", "assets": pins, "unit": UNIT, "socket": SOCKET,
            "binDirectory": bin_dir(pins[0].version), "config": CONFIG, "receiptPath": RECEIPT,
        })),
        Operation::Status => status(host),
        Operation::Install | Operation::Remove => {
            Ok(serde_json::json!({ "code": mutate(host, &pins, op)? }))
        }
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn cli(host: &impl Host) -> std::process::ExitCode {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let json = args.last().is_some_and(|arg| arg == "--json");
    let args = &args[..args.len() - usize::from(json)];
    let op = match args {
        [component, op] if component == "containerd" => match op.to_str() {
            Some("plan") => Some(Operation::Plan),
            Some("status") => Some(Operation::Status),
            Some("install") => Some(Operation::Install),
            Some("remove") => Some(Operation::Remove),
            _ => None,
        },
        _ => None,
    };
    let Some(op) = op else {
        eprintln!("Usage: canaveral-host-installer containerd plan|install|status|remove [--json]");
        return std::process::ExitCode::from(2);
    };
    let (report, code) = match operation(host, op, std::env::consts::ARCH) {
        Ok(report) => (report, 0),
        Err(error) => {
            let code = if error.code == "unsupported_arch" {
                2
            } else {
                1
            };
            (
                serde_json::json!({ "code": error.code, "detail": error.detail }),
                code,
            )
        }
    };
    if json {
        println!(
            "{}",
            serde_json::json!({
                "type": "canaveral-host-installer-report", "version": 1,
                "operation": op.name(), "component": "containerd", "result": report,
            })
        );
    } else {
        println!("{report:#}");
    }
    std::process::ExitCode::from(code)
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
