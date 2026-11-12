use canaveral_guest_protocol::{
    bundle::{Artifact, Manifest},
    Result,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pin {
    pub identity: String,
    pub sha256: String,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Debian {
    pub snapshot: String,
    pub release: Pin,
    pub signing_key: Pin,
    pub signature: Pin,
    pub packages: Vec<Pin>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Provenance {
    pub debian: Debian,
    pub node: Pin,
    pub node_signature: Pin,
    pub node_signing_key: Pin,
    pub rust: Vec<Pin>,
    pub kernel_source: Pin,
    pub kernel_config: Pin,
    pub kernel_patches: Vec<Pin>,
    pub erofs_tool: Pin,
    pub bootstrap_source: Pin,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Recipe {
    pub version: u32,
    pub id: String,
    pub revision: u64,
    pub command_line: String,
    pub tool_versions: BTreeMap<String, String>,
    pub epoch: u32,
    pub kernel: Artifact,
    pub rootfs: Artifact,
    pub bootstrap: Artifact,
    pub provenance: Provenance,
}
impl Recipe {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > 1024 * 1024 {
            return Err("recipe too large".into());
        }
        // Inspect every object before typed decoding: serde maps otherwise accept duplicates.
        let mut decoder = serde_json::Deserializer::from_slice(bytes);
        Unique::deserialize(&mut decoder)?;
        decoder.end()?;
        let r: Self = serde_json::from_slice(bytes)?;
        if r.version != 1 && r.version != 2 {
            return Err("unsupported recipe".into());
        }
        let mut candidate = r.manifest();
        // Assembly generates the initrd from this pinned bootstrap. Validate the
        // input artifact here; only assembly can publish the actual initrd pin.
        if r.version == 2 {
            candidate.initrd = Some(r.bootstrap.clone());
        }
        candidate.validate()?;
        let mut bootstrap = candidate;
        bootstrap.kernel = r.bootstrap.clone();
        bootstrap.validate()?;
        super::bootstrap::base_args(&r.command_line)?;
        if !r.tool_versions["git"].starts_with("git version ") {
            return Err("exact Git probe line required".into());
        }

        let p = &r.provenance;
        if !valid_snapshot(&p.debian.snapshot) {
            return Err("expected Debian snapshot YYYYMMDDTHHMMSSZ".into());
        }
        let mut pins = vec![
            &p.debian.release,
            &p.debian.signing_key,
            &p.debian.signature,
            &p.node,
            &p.node_signature,
            &p.node_signing_key,
            &p.kernel_source,
            &p.kernel_config,
            &p.erofs_tool,
            &p.bootstrap_source,
        ];
        if p.debian.packages.is_empty() || p.rust.is_empty() {
            return Err("package and Rust archive pins required".into());
        }
        for group in [&p.debian.packages, &p.rust, &p.kernel_patches] {
            let mut seen = std::collections::BTreeSet::new();
            for pin in group {
                if !seen.insert(&pin.identity) {
                    return Err("duplicate provenance identity".into());
                }
                pins.push(pin);
            }
        }
        for pin in pins {
            if pin.identity.is_empty()
                || pin.identity.len() > 512
                || pin.identity.trim() != pin.identity
                || !pin.identity.bytes().all(|b| (32..=126).contains(&b))
                || pin.sha256.len() != 64
                || !pin
                    .sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err("explicit provenance identity and SHA256 required".into());
            }
        }
        for pin in &p.debian.packages {
            let valid = pin
                .identity
                .split_once('=')
                .and_then(|(name, rest)| {
                    rest.rsplit_once(':')
                        .map(|(version, arch)| (name, version, arch))
                })
                .is_some_and(|(name, version, arch)| {
                    !name.is_empty()
                        && name.bytes().all(|b| {
                            b.is_ascii_lowercase() || b.is_ascii_digit() || b"+.-".contains(&b)
                        })
                        && !version.is_empty()
                        && version
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b".+:~-".contains(&b))
                        && (arch == "arm64" || arch == "all")
                });
            if !valid {
                return Err(
                    "every Debian package needs exact package=version:architecture identity".into(),
                );
            }
        }
        // Required direct packages, including version and arm64 identity; transitive closure is operator evidence.
        for name in ["bash=", "coreutils=", "git=", "ca-certificates="] {
            if !p.debian.packages.iter().any(|v| {
                v.identity.starts_with(name)
                    && v.identity
                        .strip_prefix(name)
                        .and_then(|v| v.rsplit_once(':'))
                        .is_some_and(|(version, arch)| {
                            !version.is_empty() && (arch == "arm64" || arch == "all")
                        })
            }) {
                return Err("missing required Debian package pin".into());
            }
        }
        if r.version == 2
            && !p
                .debian
                .packages
                .iter()
                .any(|v| v.identity.starts_with("e2fsprogs="))
        {
            return Err("v2 requires an exact e2fsprogs package pin".into());
        }
        if p.node.identity != "node-v24.11.0-linux-arm64.tar.xz"
            || !p
                .rust
                .iter()
                .any(|v| v.identity.starts_with("rust-1.99.1-") && v.identity.ends_with(".tar.xz"))
            || !p
                .rust
                .iter()
                .any(|v| v.identity == "rust-std-1.99.1-aarch64-unknown-linux-musl.tar.xz")
        {
            return Err("required Node/Rust archive pin missing".into());
        }
        Ok(r)
    }
    pub fn manifest(&self) -> Manifest {
        Manifest {
            version: self.version,
            id: self.id.clone(),
            revision: self.revision,
            arch: "arm64".into(),
            kernel: self.kernel.clone(),
            rootfs: self.rootfs.clone(),
            initrd: None,
            command_line: self.command_line.clone(),
            agent_vsock_port: 1024,
            protocol: 1,
            data_vsock_port: (self.version == 2).then_some(1025),
            data_protocol: (self.version == 2).then_some(1),
            tool_versions: self.tool_versions.clone(),
        }
    }
}
fn valid_snapshot(s: &str) -> bool {
    s.len() == 16
        && s.as_bytes()[8] == b'T'
        && s.as_bytes()[15] == b'Z'
        && s.bytes()
            .enumerate()
            .all(|(i, b)| i == 8 || i == 15 || b.is_ascii_digit())
}
pub(crate) struct Unique;
impl<'de> Deserialize<'de> for Unique {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = Unique;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("JSON without duplicate keys")
            }
            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                mut m: M,
            ) -> std::result::Result<Unique, M::Error> {
                let mut keys = std::collections::BTreeSet::new();
                while let Some(k) = m.next_key::<String>()? {
                    if !keys.insert(k) {
                        return Err(serde::de::Error::custom("duplicate key"));
                    }
                    m.next_value::<Unique>()?;
                }
                Ok(Unique)
            }
            fn visit_seq<S: serde::de::SeqAccess<'de>>(
                self,
                mut s: S,
            ) -> std::result::Result<Unique, S::Error> {
                while s.next_element::<Unique>()?.is_some() {}
                Ok(Unique)
            }
            fn visit_str<E: serde::de::Error>(self, _: &str) -> std::result::Result<Unique, E> {
                Ok(Unique)
            }
            fn visit_bool<E: serde::de::Error>(self, _: bool) -> std::result::Result<Unique, E> {
                Ok(Unique)
            }
            fn visit_u64<E: serde::de::Error>(self, _: u64) -> std::result::Result<Unique, E> {
                Ok(Unique)
            }
            fn visit_i64<E: serde::de::Error>(self, _: i64) -> std::result::Result<Unique, E> {
                Ok(Unique)
            }
            fn visit_f64<E: serde::de::Error>(self, _: f64) -> std::result::Result<Unique, E> {
                Ok(Unique)
            }
            fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<Unique, E> {
                Ok(Unique)
            }
        }
        d.deserialize_any(Visitor)
    }
}
