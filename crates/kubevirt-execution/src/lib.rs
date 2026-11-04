//! Bounded, namespace-scoped KubeVirt effects. No controller/runner transport.
#![cfg(unix)]
mod private;
mod transport;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
    path::Path,
};
pub use transport::Kubernetes;

pub const LIMIT: usize = 1024 * 1024;
#[derive(Debug, PartialEq, Eq)]
pub struct Error(pub &'static str);
pub type Result<T> = std::result::Result<T, Error>;
fn invalid() -> Error {
    Error("invalid configuration or private state")
}
fn io<T>(r: std::io::Result<T>) -> Result<T> {
    r.map_err(|_| Error("private state IO failed"))
}
fn bounded(r: impl Read) -> Result<Vec<u8>> {
    let mut b = Vec::new();
    io(r.take((LIMIT + 1) as u64).read_to_end(&mut b))?;
    if b.len() > LIMIT {
        return Err(Error("response limit"));
    }
    Ok(b)
}
fn dns(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 63
        && s.bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        && !s.starts_with('-')
        && !s.ends_with('-')
}
fn uuid(s: &str) -> bool {
    uuid::Uuid::parse_str(s).is_ok_and(|v| v.to_string() == s)
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub controller_id: String,
    pub runner_id: String,
    pub generation: u64,
    pub incarnation_id: String,
}
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Resources {
    pub cpu: u32,
    pub memory_mi_b: u64,
    pub disk_gi_b: u64,
}
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Image {
    pub id: String,
    pub revision: String,
    pub arch: String,
    pub backend: String,
    pub digest: String,
}
/// Extracted held assignment plus canonical VM identity and exact enrolled binding.
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Assignment {
    pub id: String,
    pub claim_id: String,
    pub lease_id: String,
    pub member_id: String,
    pub domain_id: String,
    pub vm_id: String,
    pub binding: Binding,
    pub image: Image,
    pub resources: Resources,
    pub observed_revision: u64,
    pub expires_at: i64,
    pub controller_now: i64,
}
/// Operator-installed CSI snapshot inventory. No URL, registry pull or ingestion.
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
pub struct InstalledImage {
    pub image: Image,
    pub snapshot: String,
    pub snapshot_uid: String,
    pub storage_class: String,
    pub disk_gib: u64,
}
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
pub struct Scope {
    pub namespace: String,
    pub service_account: String,
    pub cluster_id: String,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Record {
    assignment: Assignment,
    scope: Scope,
    image: InstalledImage,
    creation: String,
    userdata_digest: Option<String>,
    stopping: bool,
    objects: BTreeMap<String, Option<String>>,
    graph: BTreeMap<String, Node>,
    stopped: bool,
}
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
struct Node {
    kind: String,
    name: String,
    uid: String,
    parent: Option<String>,
}
/// Implementations must enforce expiry independently of this process AND cluster
/// API availability. A string/config assertion is not a fencing implementation.
/// No production implementation ships in this crate.
mod fence_boundary {
    pub trait Sealed {}
    #[cfg(test)]
    impl<T> Sealed for T {}
    #[cfg(not(test))]
    impl Sealed for super::MissingFence {}
}
/// Injection is available only in this crate’s unit tests.
pub trait DeadlineFence: fence_boundary::Sealed {
    fn authorize(&mut self, assignment: &Assignment, scope: &Scope) -> Result<()>;
    /// Prevent every delayed VM start and independently fence execution before return.
    fn quiesce(&mut self, assignment: &Assignment, scope: &Scope) -> Result<()>;
    /// Positive backend erasure evidence; API object absence alone is insufficient.
    fn storage_erased(&mut self, _assignment: &Assignment, _uid: &str) -> Result<bool> {
        Ok(false)
    }
    fn credentials_erased(&mut self, _assignment: &Assignment, _uid: &str) -> Result<bool> {
        Ok(false)
    }
}
pub struct MissingFence;
impl DeadlineFence for MissingFence {
    fn authorize(&mut self, _: &Assignment, _: &Scope) -> Result<()> {
        Err(Error("independent deadline fence missing"))
    }
    fn quiesce(&mut self, _: &Assignment, _: &Scope) -> Result<()> {
        Err(Error("independent deadline fence missing"))
    }
}
/// HTTP status is never inferred from a transport error. Only exact GET 404 is absence.
pub trait Api {
    fn scope(&self) -> &Scope;
    fn request(&mut self, method: &str, path: &str, body: Option<&Value>) -> Result<(u16, Value)>;
}

pub struct Adapter<A: Api, F: DeadlineFence> {
    api: A,
    fence: F,
    dir: private::Directory,
    record: Record,
    poisoned: bool,
}
#[derive(Debug, PartialEq, Eq)]
pub struct Observation {
    /// Unknown for metadata-only inventory; never substitutes for positive stop evidence.
    pub running: Option<bool>,
    pub execution_stopped: bool,
    pub storage_removed: bool,
    pub credentials_erased: bool,
}
impl<A: Api, F: DeadlineFence> Adapter<A, F> {
    pub fn prepare(
        path: &Path,
        api: A,
        fence: F,
        scope: Scope,
        assignment: Assignment,
        image: InstalledImage,
    ) -> Result<Self> {
        validate(&scope, &assignment, &image)?;
        if api.scope() != &scope {
            return Err(invalid());
        }
        let mut random = [0; 16];
        getrandom::fill(&mut random).map_err(|_| invalid())?;
        let dir = private::Directory::create(path)?;
        let record = Record {
            assignment,
            scope,
            image,
            creation: uuid::Uuid::from_bytes(random).to_string(),
            userdata_digest: None,
            stopping: false,
            objects: BTreeMap::new(),
            graph: BTreeMap::new(),
            stopped: false,
        };
        let mut s = Self {
            api,
            fence,
            dir,
            record,
            poisoned: false,
        };
        s.save()?;
        Ok(s)
    }
    pub fn resume(
        path: &Path,
        api: A,
        fence: F,
        scope: &Scope,
        assignment: &Assignment,
        image: &InstalledImage,
    ) -> Result<Self> {
        validate(scope, assignment, image)?;
        if api.scope() != scope {
            return Err(invalid());
        }
        let dir = private::Directory::open(path)?;
        let record: Record =
            serde_json::from_slice(&dir.read("identity.json")?).map_err(|_| invalid())?;
        if &record.assignment != assignment
            || &record.scope != scope
            || &record.image != image
            || !uuid(&record.creation)
        {
            return Err(invalid());
        }
        Ok(Self {
            api,
            fence,
            dir,
            record,
            poisoned: false,
        })
    }
    fn save(&mut self) -> Result<()> {
        if self.poisoned {
            return Err(invalid());
        }
        let bytes = serde_json::to_vec(&self.record).map_err(|_| invalid())?;
        if bytes.len() > LIMIT {
            self.poisoned = true;
            return Err(invalid());
        }
        if let Err(e) = self.dir.write(&bytes) {
            self.poisoned = true;
            return Err(e);
        }
        Ok(())
    }
    fn path(&self, kind: &str, name: Option<&str>) -> String {
        let group = if kind == "vm" || kind == "vmi" {
            "apis/kubevirt.io/v1"
        } else if kind == "snapshot" {
            "apis/snapshot.storage.k8s.io/v1"
        } else {
            "api/v1"
        };
        let plural = match kind {
            "vm" => "virtualmachines",
            "vmi" => "virtualmachineinstances",
            "pvc" => "persistentvolumeclaims",
            "secret" => "secrets",
            "snapshot" => "volumesnapshots",
            _ => "pods",
        };
        format!(
            "/{group}/namespaces/{}/{plural}{}",
            self.record.scope.namespace,
            name.map(|n| format!("/{n}")).unwrap_or_default()
        )
    }
    fn name(&self) -> String {
        format!("cvm-{}", self.record.assignment.vm_id)
    }
    fn annotations(&self) -> Value {
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&(
                    &self.record.assignment,
                    &self.record.scope,
                    &self.record.image
                ))
                .expect("serializable")
            )
        );
        json!({"canaveral.io/creation-id":self.record.creation,"canaveral.io/assignment":fingerprint})
    }
    #[cfg(test)]
    fn metadata(&self) -> Value {
        json!({"name":self.name(),"namespace":self.record.scope.namespace,"annotations":self.annotations(),"labels":{"canaveral.io/machine":self.record.assignment.vm_id}})
    }
    fn get(&mut self, kind: &str) -> Result<Option<Value>> {
        let path = self.path(kind, Some(&self.name()));
        let (status, v) = self.api.request("GET", &path, None)?;
        match status {
            200 => Ok(Some(v)),
            404 => Ok(None),
            _ => Err(Error("API observation unknown")),
        }
    }
    fn verify(&self, kind: &str, v: &Value) -> Result<String> {
        let expected = match kind {
            "vm" => "VirtualMachine",
            "pvc" => "PersistentVolumeClaim",
            _ => "Secret",
        };
        let version = if kind == "vm" { "kubevirt.io/v1" } else { "v1" };
        let m = &v["metadata"];
        let uid = m["uid"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 128)
            .ok_or(invalid())?;
        if v["kind"] != expected
            || v["apiVersion"] != version
            || m["name"] != self.name()
            || m["namespace"] != self.record.scope.namespace
            || !self
                .annotations()
                .as_object()
                .ok_or_else(invalid)?
                .iter()
                .all(|(k, v)| m["annotations"].get(k) == Some(v))
            || m["labels"]["canaveral.io/machine"] != self.record.assignment.vm_id
            || self
                .record
                .objects
                .get(kind)
                .and_then(|u| u.as_deref())
                .is_some_and(|u| u != uid)
        {
            return Err(Error("object ownership mismatch"));
        }
        Ok(uid.into())
    }
    /// One POST per kind for the lifetime of the durable intent. A lost reply can
    /// only recover by exact annotations; absence never authorizes a second POST.
    #[cfg(test)]
    fn ensure(&mut self, kind: &str, body: Value) -> Result<()> {
        if self.record.objects.contains_key(kind) {
            return self.recover(kind);
        }
        self.record.objects.insert(kind.into(), None);
        self.save()?;
        let path = self.path(kind, None);
        let (status, v) = self.api.request("POST", &path, Some(&body))?;
        if status != 201 {
            return Err(Error("create outcome requires reconciliation"));
        }
        let uid = self.verify(kind, &v)?;
        self.record.objects.insert(kind.into(), Some(uid));
        self.save()
    }
    pub fn recover(&mut self, kind: &str) -> Result<()> {
        if !self.record.objects.contains_key(kind) {
            return Err(invalid());
        }
        let v = self
            .get(kind)?
            .ok_or(Error("creation outcome unresolved"))?;
        let uid = self.verify(kind, &v)?;
        self.record.objects.insert(kind.into(), Some(uid));
        self.save()
    }
    /// Creates a CSI snapshot clone, immutable bootstrap Secret, then VM. Credentials
    /// are input only, never persisted locally or included in error text.
    pub fn create(&mut self, _userdata: &str) -> Result<()> {
        #[cfg(not(test))]
        {
            Err(Error(
                "production creation unsupported: reviewed cluster fence required",
            ))
        }
        #[cfg(test)]
        self.create_fixture(_userdata)
    }
    #[cfg(test)]
    fn create_fixture(&mut self, userdata: &str) -> Result<()> {
        if self.record.stopping || userdata.len() > LIMIT / 4 {
            return Err(invalid());
        }
        let digest = format!("{:x}", Sha256::digest(userdata.as_bytes()));
        if self
            .record
            .userdata_digest
            .as_ref()
            .is_some_and(|d| d != &digest)
        {
            return Err(Error("bootstrap credential changed"));
        }
        self.record.userdata_digest = Some(digest);
        self.save()?;
        self.dir.check()?;
        self.fence
            .authorize(&self.record.assignment, &self.record.scope)?;
        let path = self.path("snapshot", Some(&self.record.image.snapshot));
        let (code, s) = self.api.request("GET", &path, None)?;
        if code != 200
            || s["metadata"]["uid"] != self.record.image.snapshot_uid
            || s["metadata"]["namespace"] != self.record.scope.namespace
            || s["metadata"]["name"] != self.record.image.snapshot
            || s["status"]["readyToUse"] != true
        {
            return Err(Error("installed snapshot unavailable"));
        }
        let r = self.record.assignment.resources.clone();
        self.ensure("pvc",json!({"apiVersion":"v1","kind":"PersistentVolumeClaim","metadata":self.metadata(),"spec":{"accessModes":["ReadWriteOnce"],"storageClassName":self.record.image.storage_class,"resources":{"requests":{"storage":format!("{}Gi",r.disk_gi_b)}},"dataSource":{"apiGroup":"snapshot.storage.k8s.io","kind":"VolumeSnapshot","name":self.record.image.snapshot}}}))?;
        self.ensure("secret",json!({"apiVersion":"v1","kind":"Secret","metadata":self.metadata(),"immutable":true,"type":"Opaque","stringData":{"userdata":userdata}}))?;
        self.fence
            .authorize(&self.record.assignment, &self.record.scope)?;
        self.ensure("vm",json!({"apiVersion":"kubevirt.io/v1","kind":"VirtualMachine","metadata":self.metadata(),"spec":{"runStrategy":"Always","template":{"metadata":{"annotations":self.annotations(),"labels":{"canaveral.io/machine":self.record.assignment.vm_id}},"spec":{"architecture":self.record.assignment.image.arch,"domain":{"cpu":{"cores":r.cpu},"resources":{"requests":{"cpu":r.cpu.to_string(),"memory":format!("{}Mi",r.memory_mi_b)},"limits":{"cpu":r.cpu.to_string(),"memory":format!("{}Mi",r.memory_mi_b)}},"devices":{"autoattachGraphicsDevice":false,"disks":[{"name":"root","disk":{"bus":"virtio"}},{"name":"preparation","disk":{"bus":"virtio"}}],"interfaces":[{"name":"default","masquerade":{}}]}},"networks":[{"name":"default","pod":{}}],"volumes":[{"name":"root","persistentVolumeClaim":{"claimName":self.name()}},{"name":"preparation","cloudInitNoCloud":{"secretRef":{"name":self.name()}}}]}}}}))
    }
    fn delete(&mut self, kind: &str) -> Result<()> {
        let uid = self
            .record
            .objects
            .get(kind)
            .and_then(Clone::clone)
            .ok_or(Error("no prior ownership"))?;
        if let Some(v) = self.get(kind)? {
            self.verify(kind, &v)?;
            let path = self.path(kind, Some(&self.name()));
            let (s,_)=self.api.request("DELETE",&path,Some(&json!({"apiVersion":"v1","kind":"DeleteOptions","preconditions":{"uid":uid},"propagationPolicy":"Foreground"})))?;
            if s != 200 && s != 202 {
                return Err(Error("delete outcome unknown"));
            }
        }
        Ok(())
    }
    pub fn stop(&mut self) -> Result<Observation> {
        self.record.stopping = true;
        self.save()?;
        self.fence
            .quiesce(&self.record.assignment, &self.record.scope)?;
        // Unresolved creation cannot become positive stop even when GET returns 404.
        if self.record.objects.values().any(Option::is_none) {
            return Err(Error("creation outcome unresolved"));
        }
        if !self.record.objects.contains_key("vm") {
            return Err(Error("no VM ownership"));
        }
        self.observe()?;
        self.delete("vm")?;
        self.observe()
    }
    pub fn cleanup(&mut self) -> Result<Observation> {
        let o = self.observe()?;
        if !o.execution_stopped {
            return Err(Error("positive stop required"));
        }
        self.delete("pvc")?;
        self.delete("secret")?;
        self.observe()
    }
    pub fn observe(&mut self) -> Result<Observation> {
        if self.record.stopping {
            self.fence
                .quiesce(&self.record.assignment, &self.record.scope)?;
        }
        self.dir.check()?;
        if self.poisoned {
            return Err(invalid());
        }
        if self.record.objects.values().any(Option::is_none) {
            return Err(Error("creation outcome unresolved"));
        }
        let uid = self
            .record
            .objects
            .get("vm")
            .and_then(Clone::clone)
            .ok_or(Error("no VM ownership"))?;
        let vm = self.get("vm")?;
        if let Some(v) = &vm {
            self.verify("vm", v)?;
        }
        let mut objects = Vec::new();
        for kind in ["vmi", "pod"] {
            let base = self.path(kind, None);
            let mut cursor = String::new();
            let mut cursors = BTreeSet::new();
            let mut resource_version = None;
            loop {
                let mut path = format!("{base}?limit=100");
                if !cursor.is_empty() {
                    path.push_str("&continue=");
                    path.push_str(&transport::encode_cursor(&cursor));
                }
                let (code, list) = self.api.request("GET", &path, None)?;
                let rv = list["metadata"]["resourceVersion"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or(Error("incomplete inventory"))?;
                let metadata_only = list["kind"] == "PartialObjectMetadataList"
                    && list["apiVersion"] == "meta.k8s.io/v1";
                let typed = list["kind"]
                    == if kind == "vmi" {
                        "VirtualMachineInstanceList"
                    } else {
                        "PodList"
                    }
                    && list["apiVersion"]
                        == if kind == "vmi" {
                            "kubevirt.io/v1"
                        } else {
                            "v1"
                        };
                if code != 200
                    || !(metadata_only || typed)
                    || resource_version.as_deref().is_some_and(|old| old != rv)
                {
                    return Err(Error("incomplete inventory"));
                }
                resource_version = Some(rv.to_owned());
                let items = list["items"].as_array().ok_or_else(invalid)?;
                for item in items {
                    let mut item = item.clone();
                    if list["kind"] == "PartialObjectMetadataList" {
                        if list["apiVersion"] != "meta.k8s.io/v1"
                            || item["kind"] != "PartialObjectMetadata"
                            || item["apiVersion"] != "meta.k8s.io/v1"
                        {
                            return Err(invalid());
                        }
                        item["kind"] = json!(if kind == "vmi" {
                            "VirtualMachineInstance"
                        } else {
                            "Pod"
                        });
                        item["apiVersion"] = json!(if kind == "vmi" {
                            "kubevirt.io/v1"
                        } else {
                            "v1"
                        });
                    }
                    objects.push(item);
                }
                cursor = match list["metadata"].get("continue") {
                    None => String::new(),
                    Some(v) => v.as_str().ok_or_else(invalid)?.to_owned(),
                };
                if cursor.is_empty() {
                    break;
                }
                if !cursors.insert(cursor.clone()) {
                    return Err(Error("repeated inventory page"));
                }
            }
        }
        let (nodes, owned) = graph(
            &self.record.scope.namespace,
            &self.name(),
            &uid,
            &self.record.graph,
            &objects,
        )?;
        for v in &objects {
            let m = &v["metadata"];
            let object_uid = m["uid"].as_str().ok_or_else(invalid)?;
            let machine = m["labels"]["canaveral.io/machine"].as_str();
            if owned.contains(object_uid) {
                if machine.is_some_and(|id| id != self.record.assignment.vm_id) {
                    return Err(Error("contradictory descendant identity"));
                }
                if let Some(annotations) = m["annotations"].as_object() {
                    for (key, value) in self.annotations().as_object().ok_or_else(invalid)? {
                        if annotations.get(key).is_some_and(|v| v != value) {
                            return Err(Error("contradictory descendant identity"));
                        }
                    }
                }
            } else if machine == Some(self.record.assignment.vm_id.as_str())
                || self
                    .annotations()
                    .as_object()
                    .ok_or_else(invalid)?
                    .iter()
                    .any(|(k, v)| m["annotations"].get(k) == Some(v))
            {
                return Err(Error("unproven assigned descendant"));
            }
        }
        self.record.graph = nodes;
        let stopped = self.record.stopping && vm.is_none() && owned.is_empty();
        if self.record.stopped && !stopped {
            return Err(Error("execution reappeared after stop"));
        }
        self.record.stopped = stopped;
        self.save()?;
        let mut absent = |kind: &str| -> Result<bool> {
            if self
                .record
                .objects
                .get(kind)
                .and_then(|v| v.as_ref())
                .is_none()
            {
                return Ok(false);
            }
            match self.get(kind)? {
                None => Ok(true),
                Some(v) => {
                    self.verify(kind, &v)?;
                    Ok(false)
                }
            }
        };
        let storage_absent = absent("pvc")?;
        let secret_absent = absent("secret")?;
        let storage = stopped
            && storage_absent
            && self.fence.storage_erased(
                &self.record.assignment,
                self.record.objects["pvc"].as_deref().ok_or(invalid())?,
            )?;
        let credentials = stopped
            && secret_absent
            && self.fence.credentials_erased(
                &self.record.assignment,
                self.record.objects["secret"].as_deref().ok_or(invalid())?,
            )?;
        let phases: Option<Vec<&str>> = objects
            .iter()
            .filter(|v| {
                v["kind"] == "VirtualMachineInstance"
                    && owned.contains(v["metadata"]["uid"].as_str().unwrap_or(""))
            })
            .map(|v| v["status"]["phase"].as_str())
            .collect();
        let running = phases
            .filter(|p| !p.is_empty())
            .map(|p| p.contains(&"Running"));
        Ok(Observation {
            running,
            execution_stopped: stopped,
            storage_removed: stopped && storage,
            credentials_erased: stopped && credentials,
        })
    }
}
fn validate(s: &Scope, a: &Assignment, i: &InstalledImage) -> Result<()> {
    if !dns(&s.namespace)
        || !dns(&s.service_account)
        || s.cluster_id.is_empty()
        || ![
            &a.id,
            &a.claim_id,
            &a.lease_id,
            &a.member_id,
            &a.domain_id,
            &a.vm_id,
            &a.binding.controller_id,
            &a.binding.runner_id,
            &a.binding.incarnation_id,
        ]
        .iter()
        .all(|s| uuid(s))
        || a.binding.generation == 0
        || a.observed_revision == 0
        || a.expires_at <= a.controller_now
        || a.image != i.image
        || a.image.backend != "kubevirt"
        || !["amd64", "arm64"].contains(&a.image.arch.as_str())
        || a.image.digest.len() != 71
        || !a.image.digest.starts_with("sha256:")
        || !a.image.digest[7..]
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        || !dns(&i.snapshot)
        || !dns(&i.storage_class)
        || i.snapshot_uid.is_empty()
        || a.resources.cpu == 0
        || a.resources.memory_mi_b == 0
        || a.resources.disk_gi_b != i.disk_gib
        || i.disk_gib == 0
    {
        return Err(invalid());
    }
    Ok(())
}

fn graph(
    ns: &str,
    vm_name: &str,
    vm_uid: &str,
    previous: &BTreeMap<String, Node>,
    objects: &[Value],
) -> Result<(BTreeMap<String, Node>, BTreeSet<String>)> {
    let root = Node {
        kind: "VirtualMachine".into(),
        name: vm_name.into(),
        uid: vm_uid.into(),
        parent: None,
    };
    let mut all = previous.clone();
    all.insert(vm_uid.into(), root);
    let mut current = BTreeSet::new();
    let mut names = BTreeSet::new();
    for v in objects {
        let m = &v["metadata"];
        let kind = v["kind"].as_str().ok_or(invalid())?;
        let version = if kind == "VirtualMachineInstance" {
            "kubevirt.io/v1"
        } else if kind == "Pod" {
            "v1"
        } else {
            return Err(invalid());
        };
        let name = m["name"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or(invalid())?;
        let uid = m["uid"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or(invalid())?;
        if v["apiVersion"] != version
            || m["namespace"] != ns
            || !current.insert(uid.to_string())
            || !names.insert((kind.to_string(), name.to_string()))
            || uid == vm_uid
        {
            return Err(invalid());
        }
        let refs = m["ownerReferences"].as_array().cloned().unwrap_or_default();
        let controllers: Vec<_> = refs.iter().filter(|r| r["controller"] == true).collect();
        if controllers.len() > 1 {
            return Err(invalid());
        }
        let parent = controllers
            .first()
            .map(|r| r["uid"].as_str().ok_or(invalid()).map(str::to_owned))
            .transpose()?;
        if kind == "VirtualMachineInstance" && name == vm_name && parent.as_deref() != Some(vm_uid)
        {
            return Err(Error("same-name VMI ownership unknown"));
        }
        let node = Node {
            kind: kind.into(),
            name: name.into(),
            uid: uid.into(),
            parent,
        };
        if let Some(old) = all.get(uid) {
            if old != &node {
                return Err(Error("ownership graph changed"));
            }
        }
        all.insert(uid.into(), node);
    }
    // Validate every controller reference, including names and API versions.
    for v in objects {
        if let Some(refs) = v["metadata"]["ownerReferences"].as_array() {
            for r in refs.iter().filter(|r| r["controller"] == true) {
                let parent = r["uid"].as_str().ok_or(invalid())?;
                let p = all.get(parent);
                if let Some(p) = p {
                    let version = if p.kind == "Pod" {
                        "v1"
                    } else {
                        "kubevirt.io/v1"
                    };
                    if r["kind"] != p.kind || r["name"] != p.name || r["apiVersion"] != version {
                        return Err(invalid());
                    }
                } else if r["kind"] == "VirtualMachineInstance"
                    || r["kind"] == "Pod"
                    || (r["kind"] == "VirtualMachine" && r["name"] == vm_name)
                {
                    return Err(Error("orphan ownership unknown"));
                }
                if p.is_none() {
                    let unrelated = matches!(
                        (r["kind"].as_str(), r["apiVersion"].as_str()),
                        (
                            Some("ReplicaSet" | "StatefulSet" | "DaemonSet"),
                            Some("apps/v1")
                        ) | (Some("Job"), Some("batch/v1"))
                            | (Some("VirtualMachine"), Some("kubevirt.io/v1"))
                    );
                    if !unrelated
                        || r["name"].as_str().is_none_or(str::is_empty)
                        || parent.is_empty()
                    {
                        return Err(Error("unproven external controller"));
                    }
                }
                let kind = v["kind"].as_str().ok_or(invalid())?;
                if kind == "VirtualMachineInstance" && r["kind"] != "VirtualMachine"
                    || kind == "Pod"
                        && p.is_some()
                        && r["kind"] != "VirtualMachineInstance"
                        && r["kind"] != "Pod"
                {
                    return Err(invalid());
                }
            }
        }
    }
    let mut owned = BTreeSet::new();
    for uid in &current {
        let mut cursor = uid.as_str();
        let mut seen = BTreeSet::new();
        loop {
            if !seen.insert(cursor) {
                return Err(Error("ownership cycle"));
            }
            if cursor == vm_uid {
                owned.insert(uid.clone());
                break;
            }
            match all.get(cursor).and_then(|n| n.parent.as_deref()) {
                Some(p) => cursor = p,
                None => break,
            }
        }
    }
    // Keep only proven descendants for recovery across parent deletion.
    all.retain(|uid, _| uid == vm_uid || previous.contains_key(uid) || owned.contains(uid));
    // Current owned nodes were already fully validated above.
    for v in objects {
        let uid = v["metadata"]["uid"].as_str().ok_or(invalid())?;
        if owned.contains(uid) && !all.contains_key(uid) {
            return Err(invalid());
        }
    }
    Ok((all, owned))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, rc::Rc};
    #[derive(Default)]
    struct Cluster {
        objects: BTreeMap<String, Value>,
        calls: Vec<(String, String, Option<Value>)>,
        lose: Option<String>,
        delete_timeout: bool,
        get_error: bool,
        keep_vm: bool,
        partial_list: bool,
        page_size: usize,
        page_error: bool,
        churn_page: bool,
    }
    #[derive(Clone)]
    struct Fake {
        state: Rc<RefCell<Cluster>>,
        scope: Scope,
    }
    impl Api for Fake {
        fn scope(&self) -> &Scope {
            &self.scope
        }
        fn request(&mut self, m: &str, p: &str, b: Option<&Value>) -> Result<(u16, Value)> {
            let mut c = self.state.borrow_mut();
            c.calls.push((m.into(), p.into(), b.cloned()));
            let query = p.split_once('?').map(|(_, q)| q).unwrap_or("");
            let offset = query
                .split("&continue=")
                .nth(1)
                .and_then(|s| s.parse::<usize>().ok())
                .unwrap_or(0);
            if offset > 0 && c.page_error {
                return Err(Error("fixture missing page"));
            }
            let p = p.split('?').next().unwrap();
            if m == "GET" && c.get_error {
                return Err(Error("fixture timeout"));
            }
            if m == "GET" && p.ends_with("/volumesnapshots/base") {
                return Ok((
                    200,
                    json!({"metadata":{"namespace":"fixture","name":"base","uid":"snapshot-uid"},"status":{"readyToUse":true}}),
                ));
            }
            if m == "POST" {
                assert!(!c.objects.contains_key(p));
                let mut v = b.unwrap().clone();
                v["metadata"]["annotations"]["server.example/added"] = json!("admission");
                v["metadata"]["uid"] = json!(format!("uid-{}", c.calls.len()));
                let path = format!("{p}/{}", v["metadata"]["name"].as_str().unwrap());
                c.objects.insert(path, v.clone());
                if c.lose.as_ref().is_some_and(|kind| p.ends_with(kind)) {
                    c.lose = None;
                    return Err(Error("fixture lost reply"));
                }
                return Ok((201, v));
            }
            if m == "DELETE" {
                let v = c.objects.get(p).unwrap();
                assert_eq!(b.unwrap()["preconditions"]["uid"], v["metadata"]["uid"]);
                if !c.keep_vm || !p.contains("/virtualmachines/") {
                    c.objects.remove(p);
                }
                if c.delete_timeout {
                    return Err(Error("fixture delete timeout"));
                }
                return Ok((202, json!({})));
            }
            if let Some(v) = c.objects.get(p) {
                return Ok((200, v.clone()));
            }
            if p.ends_with("/pods") || p.ends_with("/virtualmachineinstances") {
                let items: Vec<_> = c
                    .objects
                    .iter()
                    .filter(|(k, _)| k.starts_with(&format!("{p}/")))
                    .map(|(_, v)| v.clone())
                    .collect();
                let page_size = if c.page_size == 0 {
                    items.len().max(1)
                } else {
                    c.page_size
                };
                let end = (offset + page_size).min(items.len());
                let cursor = if c.partial_list {
                    "more".into()
                } else if end < items.len() {
                    end.to_string()
                } else {
                    String::new()
                };
                return Ok((
                    200,
                    json!({"apiVersion":if p.ends_with("/pods") {"v1"} else {"kubevirt.io/v1"}, "kind":if p.ends_with("/pods") {"PodList"} else {"VirtualMachineInstanceList"}, "metadata":{"resourceVersion":if offset > 0 && c.churn_page {"2"} else {"1"},"continue":cursor}, "items":items[offset..end]}),
                ));
            }
            Ok((404, json!({})))
        }
    }
    pub(super) struct FixtureFence;
    impl DeadlineFence for FixtureFence {
        fn authorize(&mut self, _: &Assignment, _: &Scope) -> Result<()> {
            Ok(())
        }
        fn quiesce(&mut self, _: &Assignment, _: &Scope) -> Result<()> {
            Ok(())
        }
        fn storage_erased(&mut self, _: &Assignment, _: &str) -> Result<bool> {
            Ok(true)
        }
        fn credentials_erased(&mut self, _: &Assignment, _: &str) -> Result<bool> {
            Ok(true)
        }
    }
    pub(super) fn input() -> (Scope, Assignment, InstalledImage) {
        let id = "00000000-0000-4000-8000-000000000001".to_string();
        let image = Image {
            id: "linux".into(),
            revision: "1".into(),
            arch: "amd64".into(),
            backend: "kubevirt".into(),
            digest: format!("sha256:{}", "a".repeat(64)),
        };
        (
            Scope {
                namespace: "fixture".into(),
                service_account: "guest".into(),
                cluster_id: "https://fixture.invalid/".into(),
            },
            Assignment {
                id: id.clone(),
                claim_id: id.clone(),
                lease_id: id.clone(),
                member_id: id.clone(),
                domain_id: id.clone(),
                vm_id: id.clone(),
                binding: Binding {
                    controller_id: id.clone(),
                    runner_id: id.clone(),
                    incarnation_id: id,
                    generation: 1,
                },
                image: image.clone(),
                resources: Resources {
                    cpu: 2,
                    memory_mi_b: 4096,
                    disk_gi_b: 20,
                },
                observed_revision: 1,
                expires_at: 200,
                controller_now: 100,
            },
            InstalledImage {
                image,
                snapshot: "base".into(),
                snapshot_uid: "snapshot-uid".into(),
                storage_class: "fixture".into(),
                disk_gib: 20,
            },
        )
    }
    fn setup() -> (tempfile::TempDir, Fake, Adapter<Fake, FixtureFence>) {
        let t = tempfile::tempdir().unwrap();
        let (s, a, i) = input();
        let api = Fake {
            state: Rc::default(),
            scope: s.clone(),
        };
        let adapter = Adapter::prepare(
            &t.path().canonicalize().unwrap().join("state"),
            api.clone(),
            FixtureFence,
            s,
            a,
            i,
        )
        .unwrap();
        (t, api, adapter)
    }
    fn posts(api: &Fake) -> usize {
        api.state
            .borrow()
            .calls
            .iter()
            .filter(|(m, _, _)| m == "POST")
            .count()
    }
    #[test]
    fn mixed_namespace_pagination_and_identity_orphans() {
        let (_t, api, mut a) = setup();
        a.create("c").unwrap();
        assert_eq!(
            a.metadata()["labels"],
            api.state.borrow().objects[&a.path("vm", Some(&a.name()))]["spec"]["template"]
                ["metadata"]["labels"]
        );
        // More than a frame in aggregate, but bounded pages. No unrelated spec is read.
        for n in 0..350 {
            let name = format!("unrelated-{n}");
            let (kind, version) = match n % 3 {
                0 => ("ReplicaSet", "apps/v1"),
                1 => ("Job", "batch/v1"),
                _ => ("StatefulSet", "apps/v1"),
            };
            let mut pod = child("Pod", &name, &name, kind, &name, &format!("parent-{n}"));
            pod["metadata"]["ownerReferences"][0]["apiVersion"] = json!(version);
            pod["metadata"]["annotations"] = json!({"unrelated.example/padding":"x".repeat(4000)});
            api.state
                .borrow_mut()
                .objects
                .insert(a.path("pod", Some(&name)), pod);
        }
        api.state.borrow_mut().page_size = 30;
        assert!(!a.observe().unwrap().execution_stopped);
        api.state.borrow_mut().page_error = true;
        assert!(a.stop().is_err());
        api.state.borrow_mut().page_error = false;
        api.state.borrow_mut().churn_page = true;
        assert!(a.stop().is_err());
        api.state.borrow_mut().churn_page = false;
        for key in ["canaveral.io/creation-id", "canaveral.io/assignment"] {
            let orphan = json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":"orphan","namespace":"fixture","uid":"orphan","annotations":{key:a.annotations()[key]}}});
            let path = a.path("pod", Some("orphan"));
            api.state.borrow_mut().objects.insert(path.clone(), orphan);
            assert_eq!(a.observe(), Err(Error("unproven assigned descendant")));
            api.state.borrow_mut().objects.remove(&path);
        }
        assert!(a.stop().unwrap().execution_stopped);
        assert_eq!(
            api.state
                .borrow()
                .objects
                .values()
                .filter(|v| v["kind"] == "Pod")
                .count(),
            350
        );
    }
    #[test]
    fn create_manifests_and_identity() {
        let (_t, api, mut a) = setup();
        a.create("secret-data").unwrap();
        assert_eq!(posts(&api), 3);
        assert!(!a.observe().unwrap().execution_stopped);
        let c = api.state.borrow();
        let v = c
            .objects
            .values()
            .find(|v| v["kind"] == "VirtualMachine")
            .unwrap();
        assert_eq!(v["spec"]["template"]["spec"]["domain"]["cpu"]["cores"], 2);
        assert_eq!(
            v["spec"]["template"]["spec"]["domain"]["resources"]["limits"]["memory"],
            "4096Mi"
        );
        assert!(v.to_string().contains("persistentVolumeClaim"));
        let bytes = std::fs::read(
            _t.path()
                .canonicalize()
                .unwrap()
                .join("state/identity.json"),
        )
        .unwrap();
        assert!(!String::from_utf8(bytes).unwrap().contains("secret-data"));
    }
    #[test]
    fn lost_reply_restart_exact_uid_recovery_no_second_post() {
        for kind in ["persistentvolumeclaims", "secrets", "virtualmachines"] {
            let (t, api, mut a) = setup();
            api.state.borrow_mut().lose = Some(kind.into());
            assert!(a.create("credential").is_err());
            let (s, assignment, i) = input();
            drop(a);
            let mut a = Adapter::resume(
                &t.path().canonicalize().unwrap().join("state"),
                api.clone(),
                FixtureFence,
                &s,
                &assignment,
                &i,
            )
            .unwrap();
            a.create("credential").unwrap();
            assert_eq!(posts(&api), 3);
            assert!(a.create("changed").is_err());
        }
    }
    #[test]
    fn persisted_intent_without_effect_never_reposts_or_claims_absence() {
        let (t, api, mut a) = setup();
        a.record.objects.insert("vm".into(), None);
        a.save().unwrap();
        let (s, assignment, i) = input();
        drop(a);
        let mut a = Adapter::resume(
            &t.path().canonicalize().unwrap().join("state"),
            api.clone(),
            FixtureFence,
            &s,
            &assignment,
            &i,
        )
        .unwrap();
        assert!(a.recover("vm").is_err());
        assert!(a.stop().is_err());
        assert_eq!(posts(&api), 0);
    }
    #[test]
    fn replacement_uid_or_annotations_never_adopt_or_delete() {
        for change in ["uid", "annotations"] {
            let (_t, api, mut a) = setup();
            a.create("credential").unwrap();
            let path = a.path("vm", Some(&a.name()));
            api.state.borrow_mut().objects.get_mut(&path).unwrap()["metadata"][change] =
                json!("replacement");
            assert!(a.observe().is_err());
            assert!(a.stop().is_err());
            assert!(!api
                .state
                .borrow()
                .calls
                .iter()
                .any(|(m, _, _)| m == "DELETE"));
        }
    }
    #[test]
    fn lost_create_reply_cannot_adopt_reused_name() {
        let (_t, api, mut a) = setup();
        api.state.borrow_mut().lose = Some("virtualmachines".into());
        assert!(a.create("c").is_err());
        let path = a.path("vm", Some(&a.name()));
        api.state.borrow_mut().objects.get_mut(&path).unwrap()["metadata"]["annotations"] =
            json!({});
        assert!(a.recover("vm").is_err());
        assert!(a.stop().is_err());
    }
    #[test]
    fn ambiguous_delete_remains_unknown_then_observation_recovers() {
        let (_t, api, mut a) = setup();
        a.create("c").unwrap();
        api.state.borrow_mut().delete_timeout = true;
        assert!(a.stop().is_err());
        let o = a.observe().unwrap();
        assert!(o.execution_stopped);
        assert!(!o.storage_removed && !o.credentials_erased);
        api.state.borrow_mut().delete_timeout = false;
        assert!(a.cleanup().unwrap().storage_removed);
    }
    #[test]
    fn timeout_or_pending_delete_never_means_stopped() {
        let (_t, api, mut a) = setup();
        a.create("c").unwrap();
        api.state.borrow_mut().keep_vm = true;
        assert!(!a.stop().unwrap().execution_stopped);
        assert!(a.cleanup().is_err());
        api.state.borrow_mut().get_error = true;
        assert!(a.observe().is_err());
    }
    fn child(
        kind: &str,
        name: &str,
        uid: &str,
        parent_kind: &str,
        parent_name: &str,
        parent_uid: &str,
    ) -> Value {
        json!({"apiVersion":if kind=="Pod"{"v1"}else{"kubevirt.io/v1"},"kind":kind,"metadata":{"namespace":"fixture","name":name,"uid":uid,"ownerReferences":[{"apiVersion":if parent_kind=="Pod"{"v1"}else{"kubevirt.io/v1"},"kind":parent_kind,"name":parent_name,"uid":parent_uid,"controller":true}]},"status":{"phase":"Running"}})
    }
    #[test]
    fn graph_tracks_launcher_migration_support_after_parents_disappear() {
        let (_t, api, mut a) = setup();
        a.create("c").unwrap();
        let uid = a.record.objects["vm"].clone().unwrap();
        let vmi = child(
            "VirtualMachineInstance",
            &a.name(),
            "vmi-uid",
            "VirtualMachine",
            &a.name(),
            &uid,
        );
        let pod = child(
            "Pod",
            "launcher",
            "pod-uid",
            "VirtualMachineInstance",
            &a.name(),
            "vmi-uid",
        );
        let support = child(
            "Pod",
            "support",
            "support-uid",
            "Pod",
            "launcher",
            "pod-uid",
        );
        let target = child(
            "Pod",
            "migration",
            "target-uid",
            "VirtualMachineInstance",
            &a.name(),
            "vmi-uid",
        );
        for (kind, name, v) in [
            ("vmi", a.name(), vmi),
            ("pod", "launcher".into(), pod),
            ("pod", "support".into(), support),
            ("pod", "migration".into(), target),
        ] {
            api.state
                .borrow_mut()
                .objects
                .insert(a.path(kind, Some(&name)), v);
        }
        assert_eq!(a.observe().unwrap().running, Some(true));
        assert!(!a.stop().unwrap().execution_stopped);
        api.state.borrow_mut().objects.retain(|_, v| {
            !matches!(v["kind"].as_str(), Some("VirtualMachineInstance"))
                && v["metadata"]["name"] != "launcher"
        });
        assert!(!a.observe().unwrap().execution_stopped);
        api.state
            .borrow_mut()
            .objects
            .retain(|_, v| v["kind"] != "Pod");
        assert!(a.observe().unwrap().execution_stopped);
    }
    #[test]
    fn graph_rejects_spoofed_parent_cycles_and_orphans() {
        let vm = "vm";
        let uid = "root";
        let vmi = child(
            "VirtualMachineInstance",
            vm,
            "vmi",
            "VirtualMachine",
            vm,
            uid,
        );
        let pod = child(
            "Pod",
            "launcher",
            "pod",
            "VirtualMachineInstance",
            vm,
            "vmi",
        );
        let mut wrong = pod.clone();
        wrong["metadata"]["ownerReferences"][0]["name"] = json!("wrong");
        assert!(graph("fixture", vm, uid, &BTreeMap::new(), &[vmi.clone(), wrong]).is_err());
        assert!(graph("fixture", vm, uid, &BTreeMap::new(), &[pod]).is_err());
        let a = child("Pod", "a", "a", "Pod", "b", "b");
        let b = child("Pod", "b", "b", "Pod", "a", "a");
        assert!(graph("fixture", vm, uid, &BTreeMap::new(), &[a, b]).is_err());
    }
    #[test]
    fn unrelated_objects_retained_cleanup_boundaries() {
        let (_t, api, mut a) = setup();
        a.create("c").unwrap();
        for kind in ["vm", "pvc", "secret", "pod"] {
            api.state.borrow_mut().objects.insert(a.path(kind,Some("unrelated")),json!({"kind":if kind=="pod"{"Pod"}else{"Other"},"apiVersion":"v1","metadata":{"namespace":"fixture","name":"unrelated","uid":"unrelated"}}));
        }
        assert!(a.cleanup().is_err());
        assert!(a.stop().unwrap().execution_stopped);
        let o = a.cleanup().unwrap();
        assert!(o.execution_stopped && o.storage_removed && o.credentials_erased);
        assert_eq!(api.state.borrow().objects.len(), 4);
        assert!(a.create("c").is_err());
    }
    #[test]
    fn missing_fence_and_invalid_configuration_before_effects() {
        let t = tempfile::tempdir().unwrap();
        let (s, mut a, i) = input();
        let api = Fake {
            state: Rc::default(),
            scope: s.clone(),
        };
        a.resources.disk_gi_b += 1;
        assert!(Adapter::prepare(
            &t.path().canonicalize().unwrap().join("bad"),
            api.clone(),
            MissingFence,
            s.clone(),
            a,
            i.clone()
        )
        .is_err());
        assert!(!t.path().canonicalize().unwrap().join("bad").exists());
        let (_, a, _) = input();
        let mut adapter = Adapter::prepare(
            &t.path().canonicalize().unwrap().join("ok"),
            api.clone(),
            MissingFence,
            s,
            a,
            i,
        )
        .unwrap();
        assert_eq!(
            adapter.create("c"),
            Err(Error("independent deadline fence missing"))
        );
        assert!(api.state.borrow().calls.is_empty());
        assert!(adapter.stop().is_err());
        assert!(adapter.observe().is_err());
    }
    #[test]
    fn partial_inventory_and_unowned_absence_withhold_stop() {
        let (_t, api, mut a) = setup();
        assert!(a.observe().is_err());
        a.create("c").unwrap();
        api.state.borrow_mut().partial_list = true;
        assert!(a.stop().is_err());
        assert!(!api
            .state
            .borrow()
            .calls
            .iter()
            .any(|(m, _, _)| m == "DELETE"));
    }
    struct NoErasureProof;
    impl DeadlineFence for NoErasureProof {
        fn authorize(&mut self, _: &Assignment, _: &Scope) -> Result<()> {
            Ok(())
        }
        fn quiesce(&mut self, _: &Assignment, _: &Scope) -> Result<()> {
            Ok(())
        }
    }
    #[test]
    fn api_absence_never_substitutes_for_backend_erasure() {
        let (t, api, mut a) = setup();
        a.create("c").unwrap();
        a.stop().unwrap();
        drop(a);
        let (s, assignment, i) = input();
        let mut a = Adapter::resume(
            &t.path().canonicalize().unwrap().join("state"),
            api,
            NoErasureProof,
            &s,
            &assignment,
            &i,
        )
        .unwrap();
        let o = a.cleanup().unwrap();
        assert!(o.execution_stopped);
        assert!(!o.storage_removed && !o.credentials_erased);
    }
    #[test]
    fn orphan_same_name_vmi_and_contradictory_labels_withhold_stop() {
        let (_t, api, mut a) = setup();
        a.create("c").unwrap();
        let uid = a.record.objects["vm"].clone().unwrap();
        let mut vmi = child(
            "VirtualMachineInstance",
            &a.name(),
            "vmi",
            "VirtualMachine",
            &a.name(),
            &uid,
        );
        vmi["metadata"]["labels"] = json!({"canaveral.io/machine":"other"});
        let path = a.path("vmi", Some(&a.name()));
        api.state
            .borrow_mut()
            .objects
            .insert(path.clone(), vmi.clone());
        assert!(a.stop().is_err());
        vmi["metadata"].as_object_mut().unwrap().remove("labels");
        vmi["metadata"]
            .as_object_mut()
            .unwrap()
            .remove("ownerReferences");
        api.state.borrow_mut().objects.insert(path, vmi);
        assert!(a.observe().is_err());
    }
    #[test]
    fn unknown_scope_and_binding_refuse_restart_and_lock_is_exclusive() {
        let (t, api, a) = setup();
        let (s, mut assignment, i) = input();
        assert!(Adapter::resume(
            &t.path().canonicalize().unwrap().join("state"),
            api.clone(),
            FixtureFence,
            &s,
            &assignment,
            &i
        )
        .is_err());
        drop(a);
        assignment.binding.generation += 1;
        assert!(Adapter::resume(
            &t.path().canonicalize().unwrap().join("state"),
            api,
            FixtureFence,
            &s,
            &assignment,
            &i
        )
        .is_err());
    }
}

#[cfg(test)]
mod https_tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader},
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    struct Child(std::process::Child);
    impl Drop for Child {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    #[test]
    fn production_https_api_lost_reply_recovery_redirect_limit_timeout() {
        let t = tempfile::tempdir().unwrap();
        let path = t.path().canonicalize().unwrap();
        let mut child = Child(
            Command::new("node")
                .arg(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/tests/api-fixture.mjs"
                ))
                .arg(&path)
                .stdout(Stdio::piped())
                // The fixture prints public certificate diagnostics only if it rejects its chain.
                .stderr(Stdio::inherit())
                .spawn()
                .expect("fixture needs node and openssl"),
        );
        let mut origin = String::new();
        BufReader::new(child.0.stdout.take().unwrap())
            .read_line(&mut origin)
            .unwrap();
        assert!(origin.starts_with("https://localhost:"));
        let (mut scope, assignment, image) = super::tests::input();
        scope.cluster_id = origin.trim().into();
        let ca = std::fs::read(path.join("ca.pem")).unwrap();
        let make =
            |deadline| Kubernetes::new(scope.clone(), "fixture-token", &ca, deadline).unwrap();
        let mut a = Adapter::prepare(
            &path.join("state"),
            make(Duration::from_secs(2)),
            super::tests::FixtureFence,
            scope.clone(),
            assignment.clone(),
            image.clone(),
        )
        .unwrap();
        assert!(a.create("fixture-credential").is_err());
        drop(a);
        let mut a = Adapter::resume(
            &path.join("state"),
            make(Duration::from_secs(2)),
            super::tests::FixtureFence,
            &scope,
            &assignment,
            &image,
        )
        .unwrap();
        for kind in ["secret", "vm"] {
            assert_eq!(
                a.create("fixture-credential"),
                Err(Error("API transport outcome unknown")),
                "{kind}"
            );
            drop(a);
            a = Adapter::resume(
                &path.join("state"),
                make(Duration::from_secs(2)),
                super::tests::FixtureFence,
                &scope,
                &assignment,
                &image,
            )
            .unwrap();
        }
        a.create("fixture-credential").unwrap();
        assert!(a.stop().unwrap().execution_stopped);
        let o = a.cleanup().unwrap();
        assert_eq!(o.running, None);
        assert!(o.storage_removed && o.credentials_erased);
        let mut api = make(Duration::from_millis(150));
        let prefix = "/api/v1/namespaces/fixture/pods/";
        assert_eq!(
            api.request("GET", &format!("{prefix}redirect"), None)
                .unwrap()
                .0,
            307
        );
        assert_eq!(
            api.request("GET", &format!("{prefix}leaked"), None)
                .unwrap()
                .1["redirects"],
            1
        );
        assert_eq!(
            api.request("GET", &format!("{prefix}oversize"), None),
            Err(Error("response limit"))
        );
        let start = Instant::now();
        let error = api
            .request("GET", &format!("{prefix}timeout"), None)
            .unwrap_err();
        assert!(start.elapsed() < Duration::from_secs(2));
        assert!(!format!("{error:?}").contains("fixture-token"));
        assert!(api
            .request("GET", "/api/v1/namespaces/other/pods", None)
            .is_err());
        let audit_path = format!("{prefix}audit");
        let before = api.request("GET", &audit_path, None).unwrap().1;
        let mut wrong_account = scope.clone();
        wrong_account.service_account = "other".into();
        let mut client =
            Kubernetes::new(wrong_account, "fixture-token", &ca, Duration::from_secs(1)).unwrap();
        assert_eq!(
            client.request("GET", "/api/v1/namespaces/fixture/pods", None),
            Err(Error("API account scope mismatch"))
        );
        let mut wrong_host = scope.clone();
        wrong_host.cluster_id = wrong_host.cluster_id.replace("localhost", "127.0.0.1");
        let mut client =
            Kubernetes::new(wrong_host, "fixture-token", &ca, Duration::from_secs(1)).unwrap();
        assert_eq!(
            client.request("GET", "/api/v1/namespaces/fixture/pods", None),
            Err(Error("API transport outcome unknown"))
        );
        let other_ca = std::fs::read(path.join("other-ca.pem")).unwrap();
        let mut client = Kubernetes::new(
            scope.clone(),
            "fixture-token",
            &other_ca,
            Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(
            client.request("GET", "/api/v1/namespaces/fixture/pods", None),
            Err(Error("API transport outcome unknown"))
        );
        let after = api.request("GET", &audit_path, None).unwrap().1;
        assert_eq!(
            after["reviews"].as_u64().unwrap(),
            before["reviews"].as_u64().unwrap() + 1
        ); // account mismatch only; TLS failures send no bearer
        assert_eq!(after["resourceRequests"], before["resourceRequests"]);
        for route in [
            "/api/v1/namespaces/other/pods/namespaces/fixture/pods",
            "/api/v1/namespaces/fixture/pods/%61",
            "/api/v1/namespaces/fixture/pods?limit=100&watch=true",
            "/api/v1/namespaces/fixture/configmaps",
        ] {
            assert_eq!(api.request("GET", route, None), Err(invalid()));
        }
        let mut bad = scope;
        bad.cluster_id = "http://localhost/".into();
        assert!(Kubernetes::new(bad, "token", &ca, Duration::from_secs(1)).is_err());
    }
}
