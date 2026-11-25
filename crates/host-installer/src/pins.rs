use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Pin {
    pub name: &'static str,
    pub version: &'static str,
    pub url: &'static str,
    pub bytes: usize,
    pub sha256: &'static str,
}

// pins.json is the single source for these pins. The runtime qualification
// tool (script/qualification.mjs) reads the same file.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Catalog {
    #[allow(dead_code)]
    retrieved: &'static str,
    #[allow(dead_code)]
    source: &'static str,
    x86_64: [Pin; 2],
    aarch64: [Pin; 2],
}

static CATALOG: LazyLock<Catalog> = LazyLock::new(|| {
    serde_json::from_str(include_str!("pins.json")).expect("compiled containerd pins")
});

pub(crate) fn for_arch(arch: &str) -> Option<[Pin; 2]> {
    match arch {
        "x86_64" => Some(CATALOG.x86_64.clone()),
        "aarch64" => Some(CATALOG.aarch64.clone()),
        _ => None,
    }
}

#[cfg(test)]
mod catalog_tests {
    use super::*;

    #[test]
    fn pins_name_containerd_then_runc_with_matching_urls() {
        for (arch, asset) in [("x86_64", "amd64"), ("aarch64", "arm64")] {
            let [containerd, runc] = for_arch(arch).unwrap();
            assert_eq!((containerd.name, runc.name), ("containerd", "runc"));
            assert_eq!(
                containerd.url,
                format!(
                    "https://github.com/containerd/containerd/releases/download/v{0}/containerd-static-{0}-linux-{asset}.tar.gz",
                    containerd.version
                )
            );
            assert_eq!(
                runc.url,
                format!(
                    "https://github.com/opencontainers/runc/releases/download/v{}/runc.{asset}",
                    runc.version
                )
            );
            for pin in [&containerd, &runc] {
                assert!(pin.bytes > 0);
                assert!(
                    pin.sha256.len() == 64
                        && pin
                            .sha256
                            .bytes()
                            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                );
            }
        }
        assert!(for_arch("riscv64").is_none());
    }
}
