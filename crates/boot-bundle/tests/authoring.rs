#![cfg(unix)]
use canaveral_boot_bundle::{
    assemble,
    bootstrap::{self, Candidate},
    Recipe,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::{fs::symlink, process::CommandExt},
    path::PathBuf,
    process::Command,
};
static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let p = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "boot-authoring-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir(&p).unwrap();
        Self(p)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn fixture(t: &Temp) -> Value {
    let mut kernel = vec![0; 64];
    kernel[56..60].copy_from_slice(b"ARM\x64");
    kernel[16..24].copy_from_slice(&64u64.to_le_bytes());
    let mut root = vec![0; 4096];
    root[1024..1028].copy_from_slice(&0xe0f5e1e2u32.to_le_bytes());
    root[1036] = 12;
    root[1060..1064].copy_from_slice(&1u32.to_le_bytes());
    let mut elf = vec![0; 128];
    elf[..7].copy_from_slice(b"\x7fELF\x02\x01\x01");
    elf[16..18].copy_from_slice(&2u16.to_le_bytes());
    elf[18..20].copy_from_slice(&183u16.to_le_bytes());
    elf[20..24].copy_from_slice(&1u32.to_le_bytes());
    elf[24..32].copy_from_slice(&0x400000u64.to_le_bytes());
    elf[32..40].copy_from_slice(&64u64.to_le_bytes());
    elf[52..54].copy_from_slice(&64u16.to_le_bytes());
    elf[54..56].copy_from_slice(&56u16.to_le_bytes());
    elf[56..58].copy_from_slice(&1u16.to_le_bytes());
    elf[64..68].copy_from_slice(&1u32.to_le_bytes());
    elf[68..72].copy_from_slice(&5u32.to_le_bytes());
    elf[80..88].copy_from_slice(&0x400000u64.to_le_bytes());
    elf[96..104].copy_from_slice(&128u64.to_le_bytes());
    elf[104..112].copy_from_slice(&128u64.to_le_bytes());
    let mut artifacts = Vec::new();
    for (name, bytes) in [("kernel", kernel), ("rootfs", root), ("bootstrap", elf)] {
        fs::write(t.0.join(name), &bytes).unwrap();
        artifacts.push(
            json!({"path":name,"sha256":format!("{:x}",Sha256::digest(&bytes)),"size":bytes.len()}),
        );
    }
    // Synthetic authoring data only; no release provenance or bootability claim.
    let pin = |s: &str| json!({"identity":s,"sha256":"a".repeat(64)});
    json!({"version":1,"id":"test-only","revision":1,"commandLine":"root=/dev/vda rootfstype=erofs ro","epoch":123,"toolVersions":{"shell":"canaveral-shell-v1","node":"v24.11.0","git":"git version fixture"},"kernel":artifacts[0],"rootfs":artifacts[1],"bootstrap":artifacts[2],"provenance":{"debian":{"snapshot":"20260101T000000Z","release":pin("Release"),"signingKey":pin("key"),"signature":pin("Release.gpg"),"packages":[pin("bash=fixture:arm64"),pin("coreutils=fixture:arm64"),pin("git=fixture:arm64"),pin("ca-certificates=fixture:all")]},"node":pin("node-v24.11.0-linux-arm64.tar.xz"),"nodeSignature":pin("SHASUMS.asc"),"nodeSigningKey":pin("key"),"rust":[pin("rust-1.99.1-aarch64-unknown-linux-gnu.tar.xz"),pin("rust-std-1.99.1-aarch64-unknown-linux-musl.tar.xz")],"kernelSource":pin("kernel"),"kernelConfig":pin("config"),"kernelPatches":[],"erofsTool":pin("mkfs.erofs"),"bootstrapSource":pin("source+Cargo.lock")}})
}
fn bytes(r: &Value) -> Vec<u8> {
    serde_json::to_vec(r).unwrap()
}
#[test]
fn deterministic_archive_independent_decoder() {
    let a = Temp::new();
    let b = Temp::new();
    let r = fixture(&a);
    fixture(&b);
    for (t, mask) in [(&a, 0o077), (&b, 0o022)] {
        fs::write(t.0.join("recipe"), bytes(&r)).unwrap();
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_canaveral-boot-bundle"));
        cmd.args(["assemble", "--recipe"])
            .arg(t.0.join("recipe"))
            .arg("--inputs")
            .arg(&t.0)
            .arg("--output")
            .arg(t.0.join("out"));
        unsafe {
            cmd.pre_exec(move || {
                libc::umask(mask);
                Ok(())
            });
        }
        assert!(cmd.status().unwrap().success());
    }
    for name in [
        "Image",
        "rootfs.erofs",
        "initrd.cpio",
        "manifest.json",
        "image.digest",
        "recipe.json",
    ] {
        assert_eq!(
            fs::read(a.0.join("out").join(name)).unwrap(),
            fs::read(b.0.join("out").join(name)).unwrap()
        );
    }
    let data = fs::read(a.0.join("out/initrd.cpio")).unwrap();
    let mut pos = 0;
    let mut names = Vec::new();
    loop {
        assert_eq!(&data[pos..pos + 6], b"070701");
        let fields: Vec<_> = (0..13)
            .map(|i| {
                u32::from_str_radix(
                    std::str::from_utf8(&data[pos + 6 + i * 8..pos + 14 + i * 8]).unwrap(),
                    16,
                )
                .unwrap()
            })
            .collect();
        assert_eq!(fields[2], 0);
        assert_eq!(fields[3], 0);
        let ns = fields[11] as usize;
        let name = std::str::from_utf8(&data[pos + 110..pos + 110 + ns - 1]).unwrap();
        assert_eq!(data[pos + 110 + ns - 1], 0);
        pos = (pos + 110 + ns + 3) & !3;
        let size = fields[6] as usize;
        if name == "TRAILER!!!" {
            assert_eq!(size, 0);
            break;
        }
        assert_eq!(fields[0], names.len() as u32 + 1);
        assert_eq!(fields[5], 123);
        if name == "init" {
            assert_eq!(fields[1], 0o100500);
            assert_eq!(
                &data[pos..pos + size],
                fs::read(a.0.join("bootstrap")).unwrap()
            );
        } else {
            assert_eq!(fields[1], 0o040700);
            assert_eq!(size, 0);
        }
        names.push(name.to_owned());
        pos = (pos + size + 3) & !3;
    }
    assert_eq!(
        names,
        [
            "dev",
            "etc",
            "etc/canaveral",
            "init",
            "newroot",
            "proc",
            "sys"
        ]
    );
    assert_eq!(data.len() % 512, 0);
    assert!(data[pos..].iter().all(|b| *b == 0));
}
#[test]
fn strict_recipes() {
    let t = Temp::new();
    let r = fixture(&t);
    assert!(Recipe::parse(&bytes(&r)).is_ok());
    for path in ["/kernel", "../kernel", "a//b", "a/./b"] {
        let mut v = r.clone();
        v["kernel"]["path"] = path.into();
        assert!(Recipe::parse(&bytes(&v)).is_err());
    }
    for (key, v) in [
        ("extra", json!(1)),
        ("version", json!(2)),
        ("epoch", json!(-1)),
    ] {
        let mut x = r.clone();
        x[key] = v;
        assert!(Recipe::parse(&bytes(&x)).is_err());
    }
    let duplicate = String::from_utf8(bytes(&r))
        .unwrap()
        .replace("\"snapshot\":", "\"snapshot\":\"bad\",\"snapshot\":");
    assert!(Recipe::parse(duplicate.as_bytes()).is_err());
    let mut r = r;
    r["provenance"]["debian"]["packages"] = json!([]);
    assert!(Recipe::parse(&bytes(&r)).is_err());
}
#[test]
fn links_corruption_and_publication() {
    for case in 0..7 {
        let t = Temp::new();
        let mut r = fixture(&t);
        let out = t.0.join("out");
        match case {
            0 => {
                fs::rename(t.0.join("kernel"), t.0.join("real")).unwrap();
                symlink("real", t.0.join("kernel")).unwrap();
            }
            1 => fs::hard_link(t.0.join("kernel"), t.0.join("alias")).unwrap(),
            2 => fs::write(t.0.join("kernel"), b"bad").unwrap(),
            3 => fs::create_dir(&out).unwrap(),
            4 => {
                fs::create_dir(&out).unwrap();
                fs::write(out.join("interrupted"), b"keep").unwrap();
            }
            5 | 6 => {
                let name = if case == 5 { "bootstrap" } else { "rootfs" };
                let mut b = fs::read(t.0.join(name)).unwrap();
                if case == 5 {
                    b[64..68].copy_from_slice(&3u32.to_le_bytes());
                } else {
                    b[1036] = 0;
                }
                fs::write(t.0.join(name), &b).unwrap();
                r[name]["sha256"] = format!("{:x}", Sha256::digest(&b)).into();
            }
            _ => unreachable!(),
        };
        assert!(assemble(&bytes(&r), &t.0, &out).is_err());
        if case == 4 {
            assert_eq!(fs::read(out.join("interrupted")).unwrap(), b"keep");
        }
        assert!(!fs::read_dir(&t.0).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".canaveral-stage")));
    }
}
#[test]
fn nonce_and_device_planning() {
    let id = uuid::Uuid::from_u128(0x123);
    let base = "root=/dev/vda rootfstype=erofs ro";
    let good = format!("{base} canaveral.launch={id}");
    assert_eq!(bootstrap::launch(&good).unwrap(), id);
    for s in [
        base.to_owned(),
        format!("{good} canaveral.launch={id}"),
        good.replace("ro ", "rw "),
        good.replace("root=/dev/vda", "root=/dev/vdb"),
        format!("{base} canaveral.launch={}", uuid::Uuid::nil()),
        format!("{good} --"),
        format!("{good} root=/dev/vda"),
    ] {
        assert!(bootstrap::launch(&s).is_err(), "{s}");
    }
    let make = || Candidate {
        name: "vdc".into(),
        device: 2,
        partition: false,
        serial: id.simple().to_string()[..20].into(),
        filesystem_uuid: id,
    };
    assert!(bootstrap::select(id, 1, &[make()]).is_ok());
    assert!(bootstrap::select(id, 2, &[make()]).is_err());
    assert!(bootstrap::select(id, 1, &[make(), make()]).is_err());
    let mut d = make();
    d.partition = true;
    assert!(bootstrap::select(id, 1, &[d]).is_err());
    let mut d = make();
    d.filesystem_uuid = uuid::Uuid::nil();
    assert!(bootstrap::select(id, 1, &[d]).is_err());
    let mut d = make();
    d.serial = "wrong".into();
    assert!(bootstrap::select(id, 1, &[d]).is_err());
}
#[test]
fn host_refusal() {
    assert!(!Command::new(env!("CARGO_BIN_EXE_canaveral-bootstrap"))
        .status()
        .unwrap()
        .success());
}

#[test]
fn unsafe_ancestry_nonregular_and_leftover_staging() {
    let t = Temp::new();
    let r = fixture(&t);
    fs::create_dir(t.0.join(".canaveral-stage-interrupted")).unwrap();
    fs::write(
        t.0.join(".canaveral-stage-interrupted/owned-by-other-run"),
        b"keep",
    )
    .unwrap();
    symlink(&t.0, t.0.join("alias")).unwrap();
    assert!(assemble(&bytes(&r), &t.0.join("alias"), &t.0.join("out")).is_err());
    assert!(assemble(&bytes(&r), &t.0, &t.0.join("alias/out")).is_err());
    fs::remove_file(t.0.join("kernel")).unwrap();
    let fifo = std::ffi::CString::new(t.0.join("kernel").to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    assert!(assemble(&bytes(&r), &t.0, &t.0.join("out")).is_err());
    assert_eq!(
        fs::read(t.0.join(".canaveral-stage-interrupted/owned-by-other-run")).unwrap(),
        b"keep"
    );
}

#[test]
fn malformed_elf_headers_and_recipe_files() {
    for case in 0..6 {
        let t = Temp::new();
        let mut r = fixture(&t);
        let mut b = fs::read(t.0.join("bootstrap")).unwrap();
        match case {
            0 => b[18..20].copy_from_slice(&62u16.to_le_bytes()),
            1 => b[4] = 1,
            2 => b[32..40].copy_from_slice(&u64::MAX.to_le_bytes()),
            3 => b[64..68].copy_from_slice(&2u32.to_le_bytes()),
            4 => b[24..32].copy_from_slice(&u64::MAX.to_le_bytes()),
            5 => b[96..104].copy_from_slice(&1024u64.to_le_bytes()),
            _ => unreachable!(),
        }
        fs::write(t.0.join("bootstrap"), &b).unwrap();
        r["bootstrap"]["sha256"] = format!("{:x}", Sha256::digest(&b)).into();
        assert!(assemble(&bytes(&r), &t.0, &t.0.join("out")).is_err());
    }
    let t = Temp::new();
    let r = fixture(&t);
    fs::write(t.0.join("recipe"), bytes(&r)).unwrap();
    assert!(canaveral_boot_bundle::read_recipe(&t.0.join("recipe")).is_ok());
    symlink("recipe", t.0.join("recipe-link")).unwrap();
    assert!(canaveral_boot_bundle::read_recipe(&t.0.join("recipe-link")).is_err());
    fs::hard_link(t.0.join("recipe"), t.0.join("recipe-hardlink")).unwrap();
    assert!(canaveral_boot_bundle::read_recipe(&t.0.join("recipe")).is_err());
}

// All values here are synthetic; successful pin checks must retain trust/build gates.
fn local_evidence(t: &Temp, recipe: &mut Value) -> Value {
    fn walk(t: &Temp, value: &mut Value, role: String, entries: &mut Vec<Value>) {
        if value.get("sha256").is_some() {
            let path = format!("evidence-{}", entries.len());
            let content = format!("synthetic local bytes for {role}");
            fs::write(t.0.join(&path), &content).unwrap();
            value["sha256"] = format!("{:x}", Sha256::digest(content.as_bytes())).into();
            entries.push(json!({"role":role,"path":path,"size":content.len()}));
        } else if let Some(object) = value.as_object_mut() {
            for (key, child) in object {
                let next = if role.is_empty() {
                    key.clone()
                } else {
                    format!("{role}.{key}")
                };
                walk(t, child, next, entries);
            }
        } else if let Some(array) = value.as_array_mut() {
            for (i, child) in array.iter_mut().enumerate() {
                walk(t, child, format!("{role}[{i}]"), entries);
            }
        }
    }
    let mut entries = Vec::new();
    walk(t, &mut recipe["provenance"], String::new(), &mut entries);
    json!({"version":1,"files":entries})
}
#[test]
fn local_inputs_match_but_signature_trust_and_build_remain_unverified() {
    let t = Temp::new();
    let mut recipe = fixture(&t);
    let evidence = local_evidence(&t, &mut recipe);
    let report =
        canaveral_boot_bundle::verify_inputs(&bytes(&recipe), &bytes(&evidence), &t.0).unwrap();
    assert!(report.local_digests_verified);
    assert!(!report.cryptographic_signatures_verified);
    assert!(!report.debian_transitive_closure_verified);
    assert!(!report.production_build_ready);
    assert_eq!(
        report.checked_files,
        evidence["files"].as_array().unwrap().len() + 3
    );
    assert_eq!(
        report.recipe_sha256,
        format!("{:x}", Sha256::digest(bytes(&recipe)))
    );
    assert_eq!(
        report.evidence_sha256,
        format!("{:x}", Sha256::digest(bytes(&evidence)))
    );
    assert!(report
        .missing_build_inputs
        .iter()
        .any(|s| s.contains("gpgv")));
    assert!(!t.0.join("out").exists());
    fs::write(t.0.join("recipe.json"), bytes(&recipe)).unwrap();
    fs::write(t.0.join("evidence.json"), bytes(&evidence)).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_canaveral-boot-bundle"))
        .args(["verify-inputs", "--recipe"])
        .arg(t.0.join("recipe.json"))
        .arg("--inputs")
        .arg(&t.0)
        .arg("--evidence")
        .arg(t.0.join("evidence.json"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["cryptographicSignaturesVerified"], false);
    assert_eq!(report["productionBuildReady"], false);
}
#[test]
fn local_input_missing_duplicate_path_size_and_trust_negatives() {
    for case in 0..17 {
        let t = Temp::new();
        let mut recipe = fixture(&t);
        let mut evidence = local_evidence(&t, &mut recipe);
        let path = evidence["files"][0]["path"].as_str().unwrap().to_owned();
        match case {
            0 => {
                evidence["files"].as_array_mut().unwrap().remove(0);
            }
            1 => {
                let entry = evidence["files"][0].clone();
                evidence["files"].as_array_mut().unwrap().push(entry);
            }
            2 => evidence["files"][0]["path"] = "../outside".into(),
            3 => evidence["files"][0]["path"] = "/outside".into(),
            4 => evidence["files"][0]["path"] = "a//b".into(),
            5 => evidence["files"][0]["role"] = "unknown".into(),
            6 => evidence["files"][0]["size"] = 0.into(),
            7 => evidence["files"][0]["size"] = (9u64 << 30).into(),
            8 => evidence["files"][0]["size"] = 1.into(),
            9 => fs::remove_file(t.0.join(&path)).unwrap(),
            10 => {
                let content = fs::read(t.0.join(&path)).unwrap();
                fs::write(t.0.join(&path), vec![b'x'; content.len()]).unwrap();
            }
            11 => {
                fs::rename(t.0.join(&path), t.0.join("real-evidence")).unwrap();
                symlink("real-evidence", t.0.join(&path)).unwrap();
            }
            12 => fs::hard_link(t.0.join(&path), t.0.join("alias-evidence")).unwrap(),
            13 => evidence["files"][0]["signatureVerified"] = true.into(),
            14 => {
                // Even key bytes must match the pin: a replacement key is not accepted.
                let entry = evidence["files"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|e| e["role"] == "debian.signingKey")
                    .unwrap();
                fs::write(
                    t.0.join(entry["path"].as_str().unwrap()),
                    b"unauthorized key",
                )
                .unwrap();
            }
            15 => evidence["files"][1]["path"] = path.into(),
            16 => recipe["provenance"]["debian"]["signature"]["sha256"] = "0".repeat(64).into(),
            _ => unreachable!(),
        }
        assert!(
            canaveral_boot_bundle::verify_inputs(&bytes(&recipe), &bytes(&evidence), &t.0).is_err(),
            "case {case}"
        );
    }
    let t = Temp::new();
    let mut recipe = fixture(&t);
    let evidence = local_evidence(&t, &mut recipe);
    let duplicate = String::from_utf8(bytes(&evidence))
        .unwrap()
        .replace("\"role\":", "\"role\":\"bad\",\"role\":");
    assert!(
        canaveral_boot_bundle::verify_inputs(&bytes(&recipe), duplicate.as_bytes(), &t.0).is_err()
    );
}
