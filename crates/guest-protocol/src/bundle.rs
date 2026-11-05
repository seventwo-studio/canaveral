//! Boot bundle v1: validation and canonical digest, never downloads or builds.
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
    pub tool_versions: BTreeMap<String, String>,
}
impl Artifact {
    fn validate(&self) -> Result<()> {
        if self.path.is_empty()
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
impl Manifest {
    pub fn validate(&self) -> Result<()> {
        if self.version != 1
            || self.id.is_empty()
            || self.id.len() > 128
            || self.revision == 0
            || self.revision > crate::MAX_SAFE
            || self.arch != "arm64"
            || self.agent_vsock_port != 1024
            || self.protocol != 1
            || self.command_line.is_empty()
            || self.command_line.contains(['\0', '\n', '\r'])
        {
            return Err("invalid boot bundle contract".into());
        }
        self.kernel.validate()?;
        self.rootfs.validate()?;
        if let Some(initrd) = &self.initrd {
            initrd.validate()?;
        }
        for name in [
            "bash",
            "coreutils",
            "git",
            "ca-certificates",
            "python3",
            "node",
            "guest-agent-rust",
            "kernel",
            "debian-snapshot",
        ] {
            let pin = self.tool_versions.get(name).ok_or("missing tool pin")?;
            if pin.is_empty()
                || pin.contains(['<', '>'])
                || ["latest", "stable", "required"].contains(&pin.as_str())
            {
                return Err("unresolved tool pin".into());
            }
        }
        if self.tool_versions["node"] != "24.11.0"
            || self.tool_versions["guest-agent-rust"] != "1.99.1"
        {
            return Err("unexpected frozen tool version".into());
        }
        Ok(())
    }
    /// Canonical UTF-8 JSON: recursively sorted object keys, no whitespace/newline,
    /// serde_json string escaping; integer-only schema. Digest is lowercase SHA256.
    pub fn digest(&self) -> Result<String> {
        self.validate()?;
        let canonical = serde_json::to_vec(&serde_json::to_value(self)?)?;
        Ok(format!("{:x}", Sha256::digest(canonical)))
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
#[cfg(test)]
mod tests {
    use super::*;
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
            ("bash", "5.2"),
            ("coreutils", "9.5"),
            ("git", "2.47"),
            ("ca-certificates", "20250419"),
            ("python3", "3.13"),
            ("node", "24.11.0"),
            ("guest-agent-rust", "1.99.1"),
            ("kernel", "6.12"),
            ("debian-snapshot", "20260101T000000Z"),
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
