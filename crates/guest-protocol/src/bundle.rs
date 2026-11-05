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
        self.kernel.validate()?;
        self.rootfs.validate()?;
        if let Some(initrd) = &self.initrd {
            initrd.validate()?;
        }
        if self.tool_versions.len() != 4 {
            return Err("expected shell/git/node/python pins".into());
        }
        for name in ["shell", "git", "node", "python"] {
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
            ("python", "Python 3.13"),
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
