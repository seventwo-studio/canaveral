//! Verify local bytes referenced by provenance declarations; no signature verifier or builder.
use crate::{files, formats, recipe::Unique, Recipe};
use canaveral_guest_protocol::Result;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Read, Seek, SeekFrom},
    path::Path,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Evidence {
    version: u32,
    files: Vec<LocalInput>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalInput {
    /// Exact provenance field, with zero-based array indices, e.g. rust[0].
    role: String,
    path: String,
    size: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputReport {
    pub version: u32,
    pub recipe_sha256: String,
    pub evidence_sha256: String,
    pub local_digests_verified: bool,
    pub cryptographic_signatures_verified: bool,
    pub debian_transitive_closure_verified: bool,
    pub production_build_ready: bool,
    pub checked_files: usize,
    pub missing_build_inputs: Vec<&'static str>,
}

/// Read-only preflight, using the assembler's strict recipe and no-follow I/O.
/// Input ancestry must remain operator-controlled for the duration, as with assemble.
/// Success establishes byte equality only, including for keys/signature files.
pub fn verify_inputs(
    recipe_bytes: &[u8],
    evidence_bytes: &[u8],
    inputs: &Path,
) -> Result<InputReport> {
    let recipe = Recipe::parse(recipe_bytes)?;
    if evidence_bytes.len() > 1024 * 1024 {
        return Err("input evidence too large".into());
    }
    let mut decoder = serde_json::Deserializer::from_slice(evidence_bytes);
    Unique::deserialize(&mut decoder)?;
    decoder.end()?;
    let evidence: Evidence = serde_json::from_slice(evidence_bytes)?;
    if evidence.version != 1 {
        return Err("unsupported input evidence version".into());
    }
    // Derive the complete set from the existing recipe, never from a second pin schema.
    let provenance = serde_json::to_value(&recipe.provenance)?;
    let mut pins = BTreeMap::new();
    collect_pins("", &provenance, &mut pins);
    let mut roles = BTreeSet::new();
    let mut paths = BTreeSet::new();
    let source = files::directory(inputs)?;
    let mut held = Vec::new();
    for local in &evidence.files {
        if !roles.insert(&local.role) {
            return Err(format!("duplicate input role: {}", local.role).into());
        }
        let digest = pins
            .get(&local.role)
            .ok_or_else(|| format!("unknown input role: {}", local.role))?;
        check_path(&local.path)?;
        if !paths.insert(local.path.clone()) {
            return Err("duplicate local input path".into());
        }
        // A byte bound is mandatory even for archives. No extraction or execution occurs.
        if local.size == 0 || local.size > 8u64 << 30 {
            return Err(format!("input size outside 1..8 GiB: {}", local.role).into());
        }
        held.push(
            verify_file(&source, &local.path, local.size, digest, None)
                .map_err(|e| format!("{} ({}): {e}", local.role, local.path))?,
        );
    }
    let missing: Vec<_> = pins
        .keys()
        .filter(|k| !roles.contains(k))
        .cloned()
        .collect();
    if !missing.is_empty() {
        return Err(format!("missing local inputs: {}", missing.join(", ")).into());
    }
    for (pin, kind, limit) in [
        (&recipe.kernel, "kernel", 256 << 20),
        (&recipe.rootfs, "rootfs", 8u64 << 30),
        (&recipe.bootstrap, "bootstrap", 64 << 20),
    ] {
        if !paths.insert(pin.path.clone()) {
            return Err("artifact/evidence paths must be distinct".into());
        }
        if pin.size > limit {
            return Err("artifact exceeds authoring bound".into());
        }
        held.push(verify_file(
            &source,
            &pin.path,
            pin.size,
            &pin.sha256,
            Some(kind),
        )?);
    }
    recheck(&source, &held)?;
    Ok(InputReport {
        version: 1,
        recipe_sha256: format!("{:x}", Sha256::digest(recipe_bytes)),
        evidence_sha256: format!("{:x}", Sha256::digest(evidence_bytes)),
        local_digests_verified: true,
        cryptographic_signatures_verified: false,
        debian_transitive_closure_verified: false,
        production_build_ready: false,
        checked_files: held.len(),
        missing_build_inputs: vec![
            "Out-of-band authorized Debian/Node signing-key fingerprints and signature policy; pinned key bytes alone are declarations, not trust.",
            "On an authorized release builder: gpgv --keyring APPROVED_DEBIAN_KEYRING Release.gpg Release; bind the exact snapshot and verify signed Packages indexes, package versions/hashes and the complete transitive dependency closure before extraction.",
            "Official Node SHASUMS256.txt and detached signature, authenticated by approved Node release keys: gpgv --keyring APPROVED_NODE_KEYRING SHASUMS256.txt.sig SHASUMS256.txt; require the pinned tarball digest in that signed message. nodeSignature identity alone does not specify its signed message.",
            "Audited source revision plus Cargo.lock and verified Rust archive authenticity; build static AArch64 guest/bootstrap using cargo build --locked --release --target aarch64-unknown-linux-musl on the authorized builder with Rust 1.99.1.",
            "Kernel config/patch review for built-in required drivers and PID namespaces; build uncompressed arch/arm64/boot/Image on the authorized builder. A header check is not a driver/config or source-to-binary proof.",
            "Rootfs construction from verified package closure and Node, with fixed locale/timezone/order/ownership and recipe epoch as SOURCE_DATE_EPOCH; use the pinned EROFS tool. Bootstrap source evidence must include Cargo.lock. Opaque source/tool bytes do not prove these contents.",
            "Separately authorized artifact installation, external per-launch nonce medium and native boot/ownership/expiry/disconnect acceptance. This preflight neither builds nor admits a production bundle.",
        ],
    })
}
fn collect_pins(prefix: &str, value: &serde_json::Value, pins: &mut BTreeMap<String, String>) {
    if let Some(digest) = value.get("sha256").and_then(|v| v.as_str()) {
        pins.insert(prefix.to_owned(), digest.to_owned());
    } else if let Some(object) = value.as_object() {
        for (key, value) in object {
            collect_pins(
                &if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                },
                value,
                pins,
            );
        }
    } else if let Some(array) = value.as_array() {
        for (i, value) in array.iter().enumerate() {
            collect_pins(&format!("{prefix}[{i}]"), value, pins);
        }
    }
}
fn check_path(path: &str) -> Result<()> {
    if path.len() > 4096
        || !path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-/".contains(&b))
        || path
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
    {
        return Err("unsafe local input path".into());
    }
    Ok(())
}
fn verify_file(
    source: &std::fs::File,
    path: &str,
    size: u64,
    digest: &str,
    kind: Option<&str>,
) -> Result<HeldInput> {
    let mut file = files::relative(source, path)?;
    let before = file.metadata()?;
    files::regular(&before, size)?;
    let mut h = Sha256::new();
    let mut left = size;
    let mut buf = [0; 65536];
    while left > 0 {
        let take = left.min(buf.len() as u64) as usize;
        let n = file.read(&mut buf[..take])?;
        if n == 0 {
            return Err("short input".into());
        }
        h.update(&buf[..n]);
        left -= n as u64;
    }
    if file.read(&mut buf[..1])? != 0 || format!("{:x}", h.finalize()) != digest {
        return Err("input digest/size mismatch".into());
    }
    files::unchanged(&before, &file.metadata()?)?;
    file.seek(SeekFrom::Start(0))?;
    match kind {
        Some("kernel") => formats::kernel(&mut file)?,
        Some("rootfs") => {
            formats::erofs(&mut file)?;
        }
        Some("bootstrap") => formats::elf(&mut file)?,
        _ => (),
    }
    Ok((file, before, path.to_owned()))
}

// Reopen each original entry as well as checking its retained descriptor.
type HeldInput = (std::fs::File, std::fs::Metadata, String);
fn recheck(source: &std::fs::File, held: &[HeldInput]) -> Result<()> {
    for (file, before, path) in held {
        files::unchanged(before, &file.metadata()?)?;
        files::unchanged(before, &files::relative(source, path)?.metadata()?)?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retained_input_content_and_entry_changes_fail_final_check() {
        // Deterministically exercise the check after hashing; no scheduler race.
        for replace in [false, true] {
            let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
                "boot-preflight-change-{}-{replace}",
                std::process::id()
            ));
            std::fs::create_dir(&root).unwrap();
            let path = root.join("pin");
            std::fs::write(&path, b"original").unwrap();
            let source = files::directory(&root).unwrap();
            let held = verify_file(
                &source,
                "pin",
                8,
                &format!("{:x}", Sha256::digest(b"original")),
                None,
            )
            .unwrap();
            if replace {
                std::fs::rename(&path, root.join("old")).unwrap();
                std::fs::write(&path, b"original").unwrap();
            } else {
                std::fs::write(&path, b"changed content").unwrap();
            }
            assert!(recheck(&source, &[held]).is_err());
            std::fs::remove_dir_all(&root).unwrap();
        }
    }
}
