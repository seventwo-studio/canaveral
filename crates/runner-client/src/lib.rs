//! Explicit, outbound-only enrollment. No runtime, host credential adoption or capacity API.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{io::Read, path::Path, time::Duration};

#[cfg(unix)]
mod private;
#[cfg(unix)]
use private::Directory;
#[cfg(not(unix))]
mod unsupported {
    use super::*;
    pub(super) struct Directory;
    impl Directory {
        fn unavailable<T>() -> Result<T> {
            Err(Error(
                "secure identity storage is unsupported on this platform",
            ))
        }
        pub fn create(_: &Path) -> Result<Self> {
            Self::unavailable()
        }
        pub fn open(_: &Path) -> Result<Self> {
            Self::unavailable()
        }
        pub fn check(&self) -> Result<()> {
            Self::unavailable()
        }
        pub fn read(&self, _: &str) -> Result<Vec<u8>> {
            Self::unavailable()
        }
        pub fn write(&self, _: &[u8]) -> Result<()> {
            Self::unavailable()
        }
    }
}
#[cfg(not(unix))]
use unsupported::Directory;

pub const LIMIT: u64 = 16 * 1024;
const MAX: u64 = 9_007_199_254_740_991;
/// Errors deliberately contain no remote text, secrets, URLs or operating-system paths.
#[derive(Debug)]
pub struct Error(pub &'static str);
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;
fn invalid() -> Error {
    Error("invalid or unsafe identity state/input")
}
fn io<T>(r: std::io::Result<T>) -> Result<T> {
    r.map_err(|_| invalid())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub controller_id: uuid::Uuid,
    pub runner_id: uuid::Uuid,
    pub generation: u64,
    pub incarnation_id: uuid::Uuid,
}
impl Binding {
    fn validate(&self) -> Result<()> {
        if !(1..=MAX).contains(&self.generation) {
            return Err(invalid());
        }
        Ok(())
    }
}
/// Exact issue response, delivered by the administrator through an external secure channel.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Approval {
    pub id: uuid::Uuid,
    pub controller_id: uuid::Uuid,
    pub runner_id: uuid::Uuid,
    pub generation: u64,
    pub incarnation_id: uuid::Uuid,
    pub expires_at: f64,
    pub enrollment_token: String,
}
impl Approval {
    fn binding(&self) -> Binding {
        Binding {
            controller_id: self.controller_id,
            runner_id: self.runner_id,
            generation: self.generation,
            incarnation_id: self.incarnation_id,
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    controller_id: uuid::Uuid,
    runner_id: uuid::Uuid,
    generation: u64,
    incarnation_id: uuid::Uuid,
    credential_revision: u64,
}
impl Receipt {
    fn validate(&self, b: &Binding) -> Result<()> {
        if self.controller_id != b.controller_id
            || self.runner_id != b.runner_id
            || self.generation != b.generation
            || self.incarnation_id != b.incarnation_id
            || self.credential_revision != 1
        {
            return Err(Error("binding or credential revision rejected"));
        }
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u8,
    origin: String,
    approval: Approval,
    credential: String,
    phase: Phase,
}
#[derive(Serialize, Deserialize)]
enum Phase {
    Prepared,
    Uncertain,
    Consumed,
    Authenticated,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    record: Record,
    sha256: String,
}
fn secret(s: &str) -> bool {
    (43..=128).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
pub fn bounded(mut reader: impl Read) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    io(reader.by_ref().take(LIMIT + 1).read_to_end(&mut bytes))?;
    if bytes.len() as u64 > LIMIT {
        return Err(Error("input/response exceeds limit"));
    }
    Ok(bytes)
}
fn json<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    if bytes.len() as u64 > LIMIT {
        return Err(invalid());
    }
    serde_json::from_slice(bytes).map_err(|_| invalid())
}
fn origin(s: &str) -> Result<String> {
    let u = reqwest::Url::parse(s).map_err(|_| invalid())?;
    if u.scheme() != "https"
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || u.path() != "/"
    {
        return Err(Error(
            "expected HTTPS origin without credentials, path, query or fragment",
        ));
    }
    Ok(u.as_str().trim_end_matches('/').to_owned())
}
/// Ambient HTTP(S)_PROXY/ALL_PROXY/NO_PROXY settings are ignored. Redirects are refused.
pub struct Transport {
    client: reqwest::blocking::Client,
    origin: String,
}
impl Transport {
    pub fn new(url: &str, ca_pem: Option<&[u8]>) -> Result<Self> {
        let origin = origin(url)?;
        let mut builder = reqwest::blocking::Client::builder()
            .https_only(true)
            .retry(reqwest::retry::never())
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15));
        if let Some(pem) = ca_pem {
            if pem.len() as u64 > LIMIT {
                return Err(invalid());
            }
            let certificates = reqwest::Certificate::from_pem_bundle(pem)
                .map_err(|_| Error("invalid trusted CA"))?;
            if certificates.is_empty() {
                return Err(Error("invalid trusted CA"));
            }
            for certificate in certificates {
                builder = builder.add_root_certificate(certificate);
            }
        }
        Ok(Self {
            client: builder
                .build()
                .map_err(|_| Error("TLS client configuration failed"))?,
            origin,
        })
    }
    fn post(&self, route: &str, proof: &str, body: &serde_json::Value) -> Result<Receipt> {
        let bytes = serde_json::to_vec(body).map_err(|_| invalid())?;
        if bytes.len() as u64 > LIMIT {
            return Err(invalid());
        }
        let response = self
            .client
            .post(format!("{}{route}", self.origin))
            .bearer_auth(proof)
            .header("Content-Type", "application/json")
            .body(bytes)
            .send()
            .map_err(|_| Error("transport failed; outcome unknown"))?;
        if !response.status().is_success() {
            return Err(Error(
                "controller rejected request; reconcile current binding",
            ));
        }
        json(&bounded(response)?)
    }
}
/// Holds a lifetime advisory lock. Do not copy state: clones cannot be distinguished by this protocol.
pub struct Identity {
    dir: Directory,
    record: Record,
    poisoned: bool,
}
impl Identity {
    pub fn prepare(path: &Path, url: &str, approval: Approval) -> Result<Self> {
        approval.binding().validate()?;
        if !secret(&approval.enrollment_token)
            || !approval.expires_at.is_finite()
            || approval.expires_at < 0.0
        {
            return Err(invalid());
        }
        let origin = origin(url)?;
        let mut random = [0; 32];
        getrandom::fill(&mut random).map_err(|_| Error("secure randomness unavailable"))?;
        let credential = URL_SAFE_NO_PAD.encode(random);
        if credential == approval.enrollment_token {
            return Err(invalid());
        }
        let dir = Directory::create(path)?;
        let mut identity = Self {
            dir,
            record: Record {
                version: 1,
                origin,
                approval,
                credential,
                phase: Phase::Prepared,
            },
            poisoned: false,
        };
        identity.save()?;
        Ok(identity)
    }
    pub fn open(path: &Path, url: &str, expected: &Binding) -> Result<Self> {
        expected.validate()?;
        let dir = Directory::open(path)?;
        let envelope: Envelope = json(&dir.read("identity.json")?)?;
        let bytes = serde_json::to_vec(&envelope.record).map_err(|_| invalid())?;
        if format!("{:x}", Sha256::digest(bytes)) != envelope.sha256 {
            return Err(invalid());
        }
        let r = &envelope.record;
        if r.version != 1
            || r.origin != origin(url)?
            || r.approval.binding() != *expected
            || !secret(&r.credential)
            || !secret(&r.approval.enrollment_token)
            || r.credential == r.approval.enrollment_token
            || !r.approval.expires_at.is_finite()
            || r.approval.expires_at < 0.0
        {
            return Err(invalid());
        }
        Ok(Self {
            dir,
            record: envelope.record,
            poisoned: false,
        })
    }
    fn save(&mut self) -> Result<()> {
        self.check()?;
        let hash = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&self.record).map_err(|_| invalid())?)
        );
        let bytes = serde_json::to_vec(&serde_json::json!({"record": self.record, "sha256": hash}))
            .map_err(|_| invalid())?;
        self.poisoned = true;
        self.dir.write(&bytes)?;
        self.poisoned = false;
        Ok(())
    }
    fn check(&self) -> Result<()> {
        if self.poisoned {
            return Err(Error("state publication failed; reopen and reconcile"));
        }
        self.dir.check()
    }
    fn transport(&self, t: &Transport) -> Result<()> {
        self.check()?;
        if t.origin != self.record.origin {
            return Err(Error("controller origin differs from saved identity"));
        }
        Ok(())
    }
    /// Explicit exact retry, including after an uncertain reply. Never changes credential or binding.
    pub fn consume(&mut self, t: &Transport) -> Result<()> {
        self.transport(t)?;
        self.record.phase = Phase::Uncertain;
        self.save()?;
        let b = self.record.approval.binding();
        let mut body = serde_json::to_value(&b).map_err(|_| invalid())?;
        body["id"] = serde_json::json!(self.record.approval.id);
        body["credential"] = serde_json::json!(self.record.credential);
        self.check()?;
        t.post(
            "/v1/runner-enrollments/consume",
            &self.record.approval.enrollment_token,
            &body,
        )?
        .validate(&b)?;
        self.record.phase = Phase::Consumed;
        self.save()?;
        self.authenticate(t)
    }
    /// Narrow lease protocol API. Credentials remain inside the locked identity.
    /// A failed/lost reply is uncertain: callers persist and replay identical bodies.
    pub fn linux_lease_request(
        &self,
        t: &Transport,
        route: LeaseRoute,
        mut body: serde_json::Value,
    ) -> Result<serde_json::Value> {
        self.transport(t)?;
        if !matches!(self.record.phase, Phase::Authenticated) || !body.is_object() {
            return Err(Error("authenticated identity and object required"));
        }
        body["binding"] =
            serde_json::to_value(self.record.approval.binding()).map_err(|_| invalid())?;
        let bytes = serde_json::to_vec(&body).map_err(|_| invalid())?;
        if bytes.len() > 1024 * 1024 {
            return Err(invalid());
        }
        let response = t
            .client
            .post(format!("{}{}", t.origin, route.path()))
            .bearer_auth(&self.record.credential)
            .header("Content-Type", "application/json")
            .body(bytes)
            .send()
            .map_err(|_| Error("lease request outcome unknown"))?;
        if response.status() != reqwest::StatusCode::OK {
            return Err(Error("lease request rejected or uncertain; retain intent"));
        }
        let mut bytes = Vec::new();
        io(response.take(1024 * 1024 + 1).read_to_end(&mut bytes))?;
        if bytes.len() > 1024 * 1024 {
            return Err(invalid());
        }
        serde_json::from_slice(&bytes).map_err(|_| invalid())
    }

    /// Always contacts the controller; saved receipts never grant offline authority.
    pub fn authenticate(&mut self, t: &Transport) -> Result<()> {
        self.transport(t)?;
        self.record.phase = Phase::Uncertain;
        self.save()?;
        let b = self.record.approval.binding();
        self.check()?;
        t.post(
            "/v1/runners/authenticate",
            &self.record.credential,
            &serde_json::to_value(&b).map_err(|_| invalid())?,
        )?
        .validate(&b)?;
        self.record.phase = Phase::Authenticated;
        self.save()
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::{symlink, PermissionsExt},
    };
    fn fixture() -> (tempfile::TempDir, std::path::PathBuf, Approval, Binding) {
        let temp =
            tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let b = Binding {
            controller_id: uuid::Uuid::from_u128(1),
            runner_id: uuid::Uuid::from_u128(2),
            generation: 1,
            incarnation_id: uuid::Uuid::from_u128(3),
        };
        let a = Approval {
            id: uuid::Uuid::from_u128(4),
            controller_id: b.controller_id,
            runner_id: b.runner_id,
            generation: b.generation,
            incarnation_id: b.incarnation_id,
            expires_at: 1000.0,
            enrollment_token: "a".repeat(43),
        };
        let p = temp.path().join("identity");
        (temp, p, a, b)
    }
    #[test]
    fn restart_keeps_secret_and_binding_and_exclusive_owner() {
        let (_temp, p, a, b) = fixture();
        let mut id = Identity::prepare(&p, "https://localhost", a).unwrap();
        let credential = id.record.credential.clone();
        assert!(Identity::open(&p, "https://localhost", &b).is_err());
        id.record.phase = Phase::Uncertain;
        id.save().unwrap();
        drop(id);
        let id = Identity::open(&p, "https://localhost", &b).unwrap();
        assert_eq!(id.record.credential, credential);
        assert!(matches!(id.record.phase, Phase::Uncertain));
        drop(id);
        for changed in [
            Binding {
                generation: 2,
                ..b.clone()
            },
            Binding {
                controller_id: uuid::Uuid::nil(),
                ..b.clone()
            },
            Binding {
                incarnation_id: uuid::Uuid::nil(),
                ..b.clone()
            },
            Binding {
                runner_id: uuid::Uuid::nil(),
                ..b.clone()
            },
        ] {
            assert!(Identity::open(&p, "https://localhost", &changed).is_err());
        }
        assert!(Identity::open(&p, "https://other.invalid", &b).is_err());
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(p.join("identity.json")).unwrap()).unwrap();
        value["record"]["credential"] = serde_json::json!("z".repeat(43));
        fs::write(p.join("identity.json"), value.to_string()).unwrap();
        assert!(Identity::open(&p, "https://localhost", &b).is_err());
    }
    #[test]
    fn secure_files_and_reuse_and_swaps() {
        let (temp, p, a, b) = fixture();
        let id = Identity::prepare(&p, "https://localhost", a).unwrap();
        assert_eq!(
            fs::metadata(&p).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(p.join("identity.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        let moved = temp.path().join("moved");
        fs::rename(&p, &moved).unwrap();
        symlink(&moved, &p).unwrap();
        assert!(id.check().is_err());
        drop(id);
        assert!(Identity::open(&p, "https://localhost", &b).is_err());
        fs::remove_file(&p).unwrap();
        fs::rename(&moved, &p).unwrap();
        fs::set_permissions(p.join("identity.json"), fs::Permissions::from_mode(0o644)).unwrap();
        assert!(Identity::open(&p, "https://localhost", &b).is_err());
        fs::set_permissions(p.join("identity.json"), fs::Permissions::from_mode(0o600)).unwrap();
        fs::rename(p.join("identity.json"), p.join("real")).unwrap();
        symlink("real", p.join("identity.json")).unwrap();
        assert!(Identity::open(&p, "https://localhost", &b).is_err());
    }
    #[test]
    fn partial_initialization_and_failed_publication_fail_closed() {
        let (_temp, p, a, b) = fixture();
        let mut id = Identity::prepare(&p, "https://localhost", a).unwrap();
        fs::write(p.join("identity.pending"), b"interrupted publication").unwrap();
        assert!(id.save().is_err());
        assert!(id.check().is_err());
        drop(id);
        // The prior complete identity remains usable for explicit reconciliation, never regenerated.
        let mut reopened = Identity::open(&p, "https://localhost", &b).unwrap();
        assert!(!p.join("identity.pending").exists());
        reopened.save().unwrap();
        drop(reopened);
        fs::remove_file(p.join("identity.json")).unwrap();
        assert!(Identity::open(&p, "https://localhost", &b).is_err());
    }
    #[test]
    fn unsafe_reuse_hardlinks_and_lock_replacement() {
        let (_temp, p, a, b) = fixture();
        fs::create_dir(&p).unwrap();
        assert!(Identity::prepare(&p, "https://localhost", a).is_err());
        fs::remove_dir(&p).unwrap();
        let (_other, _unused, a, _) = fixture();
        let id = Identity::prepare(&p, "https://localhost", a).unwrap();
        // A hard-linked secret or lock could escape the private namespace.
        fs::hard_link(p.join("identity.json"), p.join("alias")).unwrap();
        drop(id);
        assert!(Identity::open(&p, "https://localhost", &b).is_err());
        fs::remove_file(p.join("alias")).unwrap();
        let id = Identity::open(&p, "https://localhost", &b).unwrap();
        fs::remove_file(p.join("owner.lock")).unwrap();
        fs::write(p.join("owner.lock"), []).unwrap();
        assert!(id.check().is_err());
        drop(id);
        fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(Identity::open(&p, "https://localhost", &b).is_err());
    }
    #[test]
    fn strict_input_and_origins() {
        for url in [
            "http://localhost",
            "https://a:b@localhost",
            "https://localhost?secret=x",
            "https://localhost/#secret",
            "https://localhost/path",
        ] {
            assert!(Transport::new(url, None).is_err());
        }
        assert!(bounded(&vec![0; LIMIT as usize + 1][..]).is_err());
        let (_t, _p, _a, mut b) = fixture();
        b.generation = MAX + 1;
        assert!(b.validate().is_err());
        assert!(json::<Binding>(br#"{"controllerId":"bad"}"#).is_err());
    }
}

#[cfg(test)]
mod ca_tests {
    use super::*;
    #[test]
    fn empty_and_noncertificate_ca_bundles_are_rejected() {
        for pem in [
            b"".as_slice(),
            b"not a certificate".as_slice(),
            b"-----BEGIN PRIVATE KEY-----\naaaa\n-----END PRIVATE KEY-----\n".as_slice(),
        ] {
            assert!(Transport::new("https://localhost", Some(pem)).is_err());
        }
    }
}

/// Only the Linux lease protocol is exposed, never arbitrary authenticated URLs.
#[derive(Clone, Copy)]
pub enum LeaseRoute {
    Claim,
    Assignments,
    Report,
    OperationPoll,
    OperationReport,
}
impl LeaseRoute {
    fn path(self) -> &'static str {
        match self {
            Self::Claim => "/v1/runners/linux-leases/claim",
            Self::Assignments => "/v1/runners/linux-leases/assignments",
            Self::Report => "/v1/runners/linux-leases/report",
            Self::OperationPoll => "/v1/runners/linux-leases/operations/poll",
            Self::OperationReport => "/v1/runners/linux-leases/operations/report",
        }
    }
}
