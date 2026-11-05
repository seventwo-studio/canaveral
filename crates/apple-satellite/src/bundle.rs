//! Operator-installed direct-boot bundle inventory.
//!
//! Preflight (every `run-once`, before any claim) is a cheap descriptor proof: nofollow
//! ancestry, ownership, mode 0400, one link, exact size, the immutable flag and file magic,
//! plus the manifest's canonical digest. It is deliberately not a content proof. Admission
//! hashes every artifact once and records its metadata identity; later checks compare that
//! identity and fail closed on any change. Content cannot change while the immutable flag is
//! set, and clearing the flag changes ctime and flags, so the recorded identity is the exact
//! trusted boundary between the admission hash and the helper's own verification.
use crate::{io, private, Installed, Result};
use canaveral_guest_protocol::bundle::Manifest;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::Read,
    os::unix::fs::{FileExt, MetadataExt},
    path::{Path, PathBuf},
};
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Format {
    /// Existing standalone EFI-bootable raw disk, copied per lease by the helper.
    #[default]
    EfiRaw,
    /// Guest bundle v1 manifest: shared read-only kernel/initrd/EROFS rootfs.
    BootBundle,
}
impl Format {
    pub fn is_efi_raw(&self) -> bool {
        *self == Self::EfiRaw
    }
}
/// Operator-installed, digest-pinned EROFS builder (erofs-utils `mkfs.erofs` or a native
/// equivalent with the same argv). Never consumer supplied and never run through a shell.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Builder {
    pub path: PathBuf,
    pub sha256: String,
}
/// Metadata identity of an immutable file; not a content digest.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Identity {
    dev: u64,
    ino: u64,
    size: u64,
    ctime: i64,
    ctime_nsec: i64,
    flags: u32,
    mode: u32,
    uid: u32,
}
/// One artifact, hashed once at admission. `sha256` is lowercase hex (Swift pin format).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pinned {
    pub role: String,
    pub path: PathBuf,
    pub sha256: String,
    pub size: u64,
    pub identity: Identity,
}
impl Pinned {
    /// The helper's `PinnedBootFile` JSON.
    pub fn swift(&self) -> serde_json::Value {
        serde_json::json!({"path": self.path, "sha256": self.sha256, "size": self.size})
    }
}
/// Direct boot relies on Darwin file flags; other hosts fail closed before any claim.
pub(crate) const SUPPORTED: bool = cfg!(target_os = "macos");
#[cfg(target_os = "macos")]
fn flags(m: &std::fs::Metadata) -> u32 {
    std::os::macos::fs::MetadataExt::st_flags(m)
}
#[cfg(not(target_os = "macos"))]
fn flags(_: &std::fs::Metadata) -> u32 {
    0
}
#[cfg(target_os = "macos")]
fn immutable(m: &std::fs::Metadata) -> bool {
    flags(m) & (libc::UF_IMMUTABLE | libc::SF_IMMUTABLE) != 0
}
#[cfg(not(target_os = "macos"))]
fn immutable(_: &std::fs::Metadata) -> bool {
    false
}
fn identity(m: &std::fs::Metadata) -> Identity {
    Identity {
        dev: m.dev(),
        ino: m.ino(),
        size: m.len(),
        ctime: m.ctime(),
        ctime_nsec: m.ctime_nsec(),
        flags: flags(m),
        mode: m.mode(),
        uid: m.uid(),
    }
}
/// Descriptor proof of a private immutable artifact, the same rules as the Swift helper.
pub(crate) fn open_immutable(path: &Path, size: u64) -> Result<(File, Identity)> {
    if !SUPPORTED {
        return Err("direct boot requires macOS immutable artifacts");
    }
    if !path.is_absolute() {
        return Err("boot artifact path must be absolute");
    }
    let file = private::open_leaf(path).map_err(|_| "unsafe boot artifact path")?;
    let m = io(file.metadata())?;
    if !m.is_file()
        || m.nlink() != 1
        || m.mode() & 0o7777 != 0o400
        || !(m.uid() == 0 || m.uid() == unsafe { libc::geteuid() })
        || m.len() != size
        || !immutable(&m)
    {
        return Err("boot artifact must be private, immutable, mode 0400 and size-pinned");
    }
    Ok((file, identity(&m)))
}
/// Full SHA-256 through the proven descriptor; identity must not move while hashing.
pub(crate) fn hash(role: &str, path: &Path, size: u64, expected: &str) -> Result<Pinned> {
    let (mut file, before) = open_immutable(path, size)?;
    let mut hash = Sha256::new();
    let mut buf = vec![0; 1 << 20];
    let mut total = 0u64;
    loop {
        let n = io(file.read(&mut buf))?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > size {
            return Err("boot artifact size changed");
        }
        hash.update(&buf[..n]);
    }
    let sha256 = format!("{:x}", hash.finalize());
    if total != size || identity(&io(file.metadata())?) != before || sha256 != expected {
        return Err("boot artifact pin mismatch");
    }
    Ok(Pinned {
        role: role.into(),
        path: path.to_owned(),
        sha256,
        size,
        identity: before,
    })
}
/// Cheap re-proof after admission: any metadata change fails closed.
pub(crate) fn recheck(p: &Pinned) -> Result<()> {
    if open_immutable(&p.path, p.size)?.1 != p.identity {
        return Err("boot artifact changed after admission");
    }
    Ok(())
}
fn magic(file: &File, offset: u64, want: &[u8]) -> Result<()> {
    let mut got = vec![0; want.len()];
    if file.read_exact_at(&mut got, offset).is_err() || got != want {
        return Err("boot artifact has the wrong format magic");
    }
    Ok(())
}
pub(crate) const EROFS_MAGIC: [u8; 4] = [0xe2, 0xe1, 0xf5, 0xe0];
/// Mirrors the helper's native direct-boot command-line requirements.
fn command_line(line: &str) -> bool {
    let t: Vec<&str> = line.split(' ').filter(|s| !s.is_empty()).collect();
    let count = |prefix: &str| t.iter().filter(|s| s.starts_with(prefix)).count();
    t.contains(&"root=/dev/vda")
        && t.contains(&"rootfstype=erofs")
        && t.contains(&"ro")
        && !t.contains(&"rw")
        && count("root=") == 1
        && count("rootfstype=") == 1
}
pub struct Bundle {
    pub manifest: Manifest,
    /// Lowercase canonical manifest digest (no `sha256:` prefix): the guest bundleDigest.
    pub digest: String,
    root: PathBuf,
}
impl Bundle {
    /// Preflight: manifest digest plus descriptor proof of every artifact. No artifact hashing.
    pub fn open(installed: &Installed) -> Result<Self> {
        let path = &installed.path;
        if !path.is_absolute() {
            return Err("boot bundle manifest path must be absolute");
        }
        let bytes = private::trust_file(path, false).map_err(|_| "unsafe boot bundle manifest")?;
        let manifest: Manifest =
            serde_json::from_slice(&bytes).map_err(|_| "invalid boot bundle manifest")?;
        // Rust-compiled canonical bytes (guest-protocol), never a Foundation encoding.
        let digest = manifest
            .digest()
            .map_err(|_| "invalid boot bundle manifest")?;
        if format!("sha256:{digest}") != installed.image.digest {
            return Err("boot bundle digest differs from image digest");
        }
        if manifest.arch != "arm64" || installed.image.arch != "arm64" {
            return Err("direct boot requires an arm64 bundle");
        }
        if manifest.initrd.is_none() {
            return Err("direct boot v1 requires a bootstrap initrd");
        }
        if !command_line(&manifest.command_line) {
            return Err("direct boot requires root=/dev/vda rootfstype=erofs ro");
        }
        let bundle = Self {
            root: path.parent().ok_or("invalid manifest path")?.to_owned(),
            manifest,
            digest,
        };
        for (role, path, size, _) in bundle.artifacts() {
            let (file, _) = open_immutable(&path, size)?;
            match role {
                "kernel" => magic(&file, 56, b"ARMd")?,
                "rootfs" => magic(&file, 1024, &EROFS_MAGIC)?,
                _ => {}
            }
        }
        Ok(bundle)
    }
    fn artifacts(&self) -> Vec<(&'static str, PathBuf, u64, &str)> {
        let m = &self.manifest;
        let mut out = vec![("kernel", &m.kernel)];
        out.extend(m.initrd.as_ref().map(|a| ("initrd", a)));
        out.push(("rootfs", &m.rootfs));
        out.into_iter()
            .map(|(role, a)| (role, self.root.join(&a.path), a.size, a.sha256.as_str()))
            .collect()
    }
    /// Admission: one full hash per artifact, recorded with its metadata identity.
    pub fn admit(&self) -> Result<Vec<Pinned>> {
        self.artifacts()
            .into_iter()
            .map(|(role, path, size, sha)| hash(role, &path, size, sha))
            .collect()
    }
}
/// The builder is pinned like the helper: exact file hash, no write bits, executable.
pub fn verify_builder(b: &Builder) -> Result<()> {
    if !b.path.is_absolute()
        || crate::hash_file(&b.path)? != b.sha256
        || io(private::open_leaf(&b.path)
            .map_err(|_| std::io::Error::other("unsafe"))
            .and_then(|f| f.metadata()))?
        .mode()
            & 0o100
            == 0
    {
        return Err("bootstrap builder pin mismatch");
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn command_line_mirrors_native_requirements() {
        assert!(command_line(
            "console=hvc0 root=/dev/vda rootfstype=erofs ro"
        ));
        for bad in [
            "root=/dev/vda rootfstype=erofs",
            "root=/dev/vda rootfstype=erofs ro rw",
            "root=/dev/vda root=/dev/vdb rootfstype=erofs ro",
            "root=/dev/vdb rootfstype=erofs ro",
        ] {
            assert!(!command_line(bad), "{bad}");
        }
    }
}
