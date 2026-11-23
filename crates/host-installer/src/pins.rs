use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub(crate) struct Pin {
    pub name: &'static str,
    pub version: &'static str,
    pub url: &'static str,
    pub bytes: usize,
    pub sha256: &'static str,
}

// GitHub latest stable releases, retrieved 2026-11-23. Sizes and SHA-256
// were computed from the assets and compared with containerd's per-asset
// .sha256sum files and upstream runc.sha256sum.
macro_rules! pins {
    ($arch:literal, $containerd_bytes:literal, $containerd_sha:literal, $runc_bytes:literal, $runc_sha:literal) => {
        [
            Pin {
                name: "containerd",
                version: "2.4.2",
                url: concat!(
                    "https://github.com/containerd/containerd/releases/download/v2.4.2/containerd-static-2.4.2-linux-",
                    $arch, ".tar.gz"
                ),
                bytes: $containerd_bytes,
                sha256: $containerd_sha,
            },
            Pin {
                name: "runc",
                version: "1.5.3",
                url: concat!("https://github.com/opencontainers/runc/releases/download/v1.5.3/runc.", $arch),
                bytes: $runc_bytes,
                sha256: $runc_sha,
            },
        ]
    };
}

pub(crate) fn for_arch(arch: &str) -> Option<[Pin; 2]> {
    match arch {
        "x86_64" => Some(pins!(
            "amd64",
            34_415_353,
            "da656542e754c699a0f438eab925e6ffdbd6346a4428e659f83dc058f04dcffe",
            10_866_576,
            "50dcc0b257d724fe07f3852c2dda52340223f038227c7572644eec870741223e"
        )),
        "aarch64" => Some(pins!(
            "arm64",
            30_823_894,
            "37b84b9534533672528141b9d815f58621a2fe5deee2daa84317800255756689",
            10_092_000,
            "07b52aee923cc432c38fe4fb6809a08fc6471994efed650af3635350588a20be"
        )),
        _ => None,
    }
}
