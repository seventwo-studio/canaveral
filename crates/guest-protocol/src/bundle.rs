//! Boot bundle v1/v2: validation and canonical digest, never downloads or builds.
use crate::Result;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::Read,
    path::{Component, Path},
};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Artifact {
    pub path: String,
    pub sha256: String,
    pub size: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub version: u32,
    pub id: String,
    pub revision: u64,
    pub arch: String,
    pub kernel: Artifact,
    pub initrd: Option<Artifact>,
    pub rootfs: Artifact,
    pub command_line: String,
    pub agent_vsock_port: u32,
    pub protocol: u32,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_u32"
    )]
    pub data_vsock_port: Option<u32>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_u32"
    )]
    pub data_protocol: Option<u32>,
    #[serde(deserialize_with = "crate::unique_map")]
    pub tool_versions: BTreeMap<String, String>,
}
fn printable(s: &str) -> bool {
    s.bytes().all(|b| (0x20..=0x7e).contains(&b))
}
impl Artifact {
    fn validate(&self) -> Result<()> {
        if self.path.is_empty()
            || !self
                .path
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-/".contains(&b))
            || self
                .path
                .split('/')
                .any(|c| c.is_empty() || c == "." || c == "..")
            || !Path::new(&self.path)
                .components()
                .all(|c| matches!(c, Component::Normal(_)))
            || self.size == 0
            || self.size > crate::MAX_SAFE
            || self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("invalid artifact; checksum/size are required inputs".into());
        }
        Ok(())
    }
    fn verify(&self, root: &Path) -> Result<()> {
        self.validate()?;
        let root = root.canonicalize()?;
        let path = root.join(&self.path).canonicalize()?;
        if !path.starts_with(&root) {
            return Err("artifact escapes bundle".into());
        }
        let mut f = std::fs::File::open(path)?;
        if !f.metadata()?.is_file() || f.metadata()?.len() != self.size {
            return Err("artifact size mismatch".into());
        }
        let mut hash = Sha256::new();
        let mut buf = [0; 65536];
        loop {
            let n = f.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hash.update(&buf[..n]);
        }
        if format!("{:x}", hash.finalize()) != self.sha256 {
            return Err("artifact hash mismatch".into());
        }
        Ok(())
    }
}
fn present_u32<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<u32>, D::Error> {
    u32::deserialize(d).map(Some)
}
impl Manifest {
    pub fn validate(&self) -> Result<()> {
        if !matches!(self.version, 1 | 2)
            || self.id.is_empty()
            || self.id.len() > 128
            || self.revision == 0
            || self.revision > crate::MAX_SAFE
            || self.arch != "arm64"
            || self.agent_vsock_port != 1024
            || self.protocol != 1
            || self.command_line.is_empty()
            // ARM64 COMMAND_LINE_SIZE=2048 includes the 54-byte launch suffix and NUL.
            || self.command_line.len() > 1993
            || self.command_line.contains(['"', '\''])
            || self.command_line.split(' ').any(|p| p == "--")
            || self
                .command_line
                .split_whitespace()
                .any(|p| p.starts_with("canaveral.launch="))
            || !printable(&self.command_line)
            || !printable(&self.id)
        {
            return Err("invalid boot bundle contract".into());
        }
        if (self.version == 1 && (self.data_vsock_port.is_some() || self.data_protocol.is_some()))
            || (self.version == 2
                && (self.data_vsock_port != Some(1025)
                    || self.data_protocol != Some(1)
                    || self.initrd.is_none()))
        {
            return Err("invalid bundle data protocol".into());
        }
        self.kernel.validate()?;
        self.rootfs.validate()?;
        if let Some(initrd) = &self.initrd {
            initrd.validate()?;
        }
        if self.tool_versions.len() != if self.version == 2 { 4 } else { 3 } {
            return Err("expected shell/git/node pins".into());
        }
        for name in ["shell", "git", "node"]
            .into_iter()
            .chain((self.version == 2).then_some("mkfsExt4"))
        {
            let pin = self.tool_versions.get(name).ok_or("missing tool pin")?;
            if pin.is_empty() || pin.len() > 128 || !printable(pin) || pin.trim() != pin {
                return Err("invalid exact probe line".into());
            }
        }
        if self.tool_versions["shell"] != "canaveral-shell-v1" {
            return Err("unexpected shell probe pin".into());
        }
        if self.tool_versions["node"] != "v24.11.0" {
            return Err("unexpected Node pin".into());
        }
        Ok(())
    }
    /// ASCII JSON, sorted keys, only quote/backslash escaped; no whitespace or LF.
    pub fn canonical_bytes(&self) -> Result<Vec<u8>> {
        self.validate()?;
        fn emit(v: &serde_json::Value, out: &mut String) {
            match v {
                serde_json::Value::Object(m) => {
                    out.push('{');
                    let mut keys: Vec<_> = m.keys().collect();
                    keys.sort();
                    for (i, k) in keys.iter().enumerate() {
                        if i != 0 {
                            out.push(',');
                        }
                        emit(&serde_json::Value::String((*k).clone()), out);
                        out.push(':');
                        emit(&m[*k], out);
                    }
                    out.push('}');
                }
                serde_json::Value::String(s) => {
                    out.push('"');
                    for c in s.chars() {
                        if c == '"' || c == '\\' {
                            out.push('\\');
                        }
                        out.push(c);
                    }
                    out.push('"');
                }
                serde_json::Value::Null => out.push_str("null"),
                serde_json::Value::Number(n) => out.push_str(&n.to_string()),
                _ => unreachable!("manifest schema has no arrays/bools"),
            }
        }
        let mut out = String::new();
        emit(&serde_json::to_value(self)?, &mut out);
        Ok(out.into_bytes())
    }
    pub fn digest(&self) -> Result<String> {
        Ok(format!("{:x}", Sha256::digest(self.canonical_bytes()?)))
    }
    pub fn verify(&self, root: &Path) -> Result<()> {
        self.validate()?;
        self.kernel.verify(root)?;
        self.rootfs.verify(root)?;
        if let Some(a) = &self.initrd {
            a.verify(root)?;
        }
        Ok(())
    }
}
/// Trusted per-launch configuration carried on the fresh launch medium as `launch.json`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Launch {
    pub binding: crate::Binding,
    pub workspace_bytes: u64,
    /// Canonical manifest supplied on the trusted per-launch medium.
    pub manifest: Manifest,
}
/// The guest reads at most this many bytes of `launch.json`.
pub const MAX_LAUNCH_BYTES: usize = 16384;
impl Launch {
    pub fn validate(&self) -> Result<()> {
        self.binding.validate()?;
        if self.manifest.version != 1 {
            return Err("legacy launch requires bundle v1".into());
        }
        if !(16 * 1024 * 1024..=1024 * 1024 * 1024).contains(&self.workspace_bytes) {
            return Err("workspace capacity must be 16MiB..1GiB".into());
        }
        if self.manifest.digest()? != self.binding.bundle_digest {
            return Err("manifest binding mismatch".into());
        }
        Ok(())
    }
    /// Validated, size-bounded bytes for the launch medium.
    pub fn to_bytes(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let bytes = serde_json::to_vec(self)?;
        if bytes.len() > MAX_LAUNCH_BYTES {
            return Err("launch config too large".into());
        }
        Ok(bytes)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn published_bytes_and_strict_schema() {
        let bytes = include_bytes!("../fixtures/canonical.json");
        let m: Manifest = serde_json::from_slice(bytes).unwrap();
        assert_eq!(m.canonical_bytes().unwrap(), bytes);
        assert_eq!(
            m.digest().unwrap(),
            include_str!("../fixtures/canonical.sha256").trim()
        );
        let mut value = serde_json::to_value(&m).unwrap();
        value["toolVersions"]["extra"] = "pin".into();
        assert!(serde_json::from_value::<Manifest>(value)
            .unwrap()
            .validate()
            .is_err());
        let mut wrong_shell = m.clone();
        wrong_shell
            .tool_versions
            .insert("shell".into(), "arbitrary".into());
        assert!(wrong_shell.validate().is_err());
        for bad in ["unicode-é", "line\n", "tab\t"] {
            let mut m = m.clone();
            m.command_line = bad.into();
            assert!(m.digest().is_err());
        }
        for bad in ["a//b", "a/./b", "a/../b", "a\\b", "é"] {
            let mut m = m.clone();
            m.kernel.path = bad.into();
            assert!(m.digest().is_err());
        }
        // Incoming field order and insignificant whitespace do not affect digest.
        let incoming = format!(
            "{{\"version\":1,{}",
            std::str::from_utf8(bytes)
                .unwrap()
                .trim_start_matches('{')
                .trim_end_matches("\"version\":1}")
                .trim_end_matches(',')
        );
        let incoming = format!("{incoming}}}");
        assert_eq!(
            serde_json::from_str::<Manifest>(&incoming)
                .unwrap()
                .digest()
                .unwrap(),
            m.digest().unwrap()
        );
        let duplicate = std::str::from_utf8(bytes)
            .unwrap()
            .replace("\"toolVersions\":{", "\"toolVersions\":{\"node\":\"bad\",");
        assert!(serde_json::from_str::<Manifest>(&duplicate).is_err());
    }
    #[test]
    fn command_line_parser_and_arm64_bound() {
        let mut m: Manifest =
            serde_json::from_slice(include_bytes!("../fixtures/canonical.json")).unwrap();
        for bad in ["ro -- rw", "ro \"rw\"", "ro 'rw'", "ro canaveral.launch=x"] {
            m.command_line = bad.into();
            assert!(m.validate().is_err());
        }
        m.command_line = "a".repeat(1993);
        assert!(m.validate().is_ok());
        assert_eq!(
            m.command_line.len() + " canaveral.launch=".len() + 36 + 1,
            2048
        );
        m.command_line.push('a');
        assert!(m.validate().is_err());
    }
    #[test]
    fn required_inputs_and_no_path_escape() {
        for path in ["/kernel", "../kernel", "kernel/../image", ""] {
            assert!(Artifact {
                path: path.into(),
                sha256: "a".repeat(64),
                size: 1
            }
            .validate()
            .is_err());
        }
        assert!(Artifact {
            path: "Image".into(),
            sha256: "REQUIRED".into(),
            size: 1
        }
        .validate()
        .is_err());
    }
    #[test]
    fn canonical_digest_and_corruption() {
        let dir = std::env::temp_dir().join(format!("canaveral-bundle-{}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("Image"), b"fixture").unwrap();
        let artifact = Artifact {
            path: "Image".into(),
            sha256: format!("{:x}", Sha256::digest(b"fixture")),
            size: 7,
        };
        let pins = [
            ("shell", "canaveral-shell-v1"),
            ("git", "git version 2.47"),
            ("node", "v24.11.0"),
        ];
        let m = Manifest {
            version: 1,
            id: "fixture".into(),
            revision: 1,
            arch: "arm64".into(),
            kernel: artifact.clone(),
            initrd: None,
            rootfs: artifact,
            command_line: "ro".into(),
            agent_vsock_port: 1024,
            protocol: 1,
            data_vsock_port: None,
            data_protocol: None,
            tool_versions: pins
                .into_iter()
                .map(|(k, v)| (k.into(), v.into()))
                .collect(),
        };
        m.verify(&dir).unwrap();
        let digest = m.digest().unwrap();
        let parsed: Manifest = serde_json::from_value(serde_json::to_value(&m).unwrap()).unwrap();
        assert_eq!(parsed.digest().unwrap(), digest);
        std::fs::write(dir.join("Image"), b"corrupt").unwrap();
        assert!(m.verify(&dir).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}

/// Workspace launch is a separate closed schema: it cannot decode as a v1 launch.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceLaunch {
    pub version: u32,
    pub binding: crate::Binding,
    pub manifest: Manifest,
    pub workspace: Workspace,
    pub egress: Egress,
    pub data: DataLaunch,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Workspace {
    pub serial: String,
    pub bytes: u64,
    pub overhead_bytes: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Egress {
    pub enabled: bool,
    pub policy: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DataLaunch {
    pub port: u32,
    pub nonce: String,
}
impl WorkspaceLaunch {
    pub fn validate(&self) -> Result<()> {
        self.binding.validate()?;
        if self.version != 2
            || self.manifest.version != 2
            || self.manifest.digest()? != self.binding.bundle_digest
            || self.workspace.bytes < 16 * 1024 * 1024
            || self.workspace.bytes > crate::MAX_SAFE
            || !self.workspace.bytes.is_multiple_of(4096)
            || self.workspace.overhead_bytes != 67108864
            || !crate::data::lower_hex(&self.workspace.serial, 20)
            || self.workspace.serial == self.binding.boot_attempt.simple().to_string()[..20]
            || self.egress.policy != "public-https-v1"
            || self.data.port != 1025
            || !crate::data::lower_hex(&self.data.nonce, 64)
        {
            return Err("invalid workspace launch".into());
        }
        Ok(())
    }
    pub fn to_bytes(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let bytes = serde_json::to_vec(self)?;
        if bytes.len() > MAX_LAUNCH_BYTES {
            return Err("launch config too large".into());
        }
        Ok(bytes)
    }
}

#[cfg(test)]
mod workspace_tests {
    use super::*;
    #[test]
    fn v2_canonical_fixture_and_legacy_downgrade_refusal() {
        let bytes = include_bytes!("../fixtures/canonical-v2.json");
        let m: Manifest = serde_json::from_slice(bytes).unwrap();
        assert_eq!(m.canonical_bytes().unwrap(), bytes);
        assert_eq!(
            m.digest().unwrap(),
            include_str!("../fixtures/canonical-v2.sha256").trim()
        );
        let launch: WorkspaceLaunch =
            serde_json::from_slice(include_bytes!("../fixtures/launch-v2.json")).unwrap();
        launch.validate().unwrap();
        let parsed: WorkspaceLaunch = serde_json::from_slice(&launch.to_bytes().unwrap()).unwrap();
        parsed.validate().unwrap();
        assert!(
            serde_json::from_slice::<Launch>(include_bytes!("../fixtures/launch-v2.json")).is_err()
        );
        let mut legacy = Launch {
            binding: launch.binding.clone(),
            workspace_bytes: 16777216,
            manifest: m.clone(),
        };
        assert!(legacy.validate().is_err());
        legacy.manifest.version = 1;
        assert!(legacy.validate().is_err());
        for field in ["dataProtocol", "dataVsockPort"] {
            let mut v = serde_json::to_value(&m).unwrap();
            v.as_object_mut().unwrap().remove(field);
            assert!(serde_json::from_value::<Manifest>(v)
                .unwrap()
                .validate()
                .is_err());
        }
        let mut bad = launch.clone();
        bad.workspace.serial = bad.binding.boot_attempt.simple().to_string()[..20].into();
        assert!(bad.validate().is_err());
        bad = launch.clone();
        bad.workspace.bytes += 1;
        assert!(bad.validate().is_err());
        bad = launch.clone();
        bad.data.nonce = bad.data.nonce.to_uppercase();
        assert!(bad.validate().is_err());
        bad = launch.clone();
        bad.workspace.overhead_bytes = 0;
        assert!(bad.validate().is_err());
        bad = launch;
        bad.manifest.version = 1;
        assert!(bad.validate().is_err());
    }
}
