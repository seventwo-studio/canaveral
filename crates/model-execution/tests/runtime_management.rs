#![cfg(any(target_os = "macos", target_os = "linux"))]

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Output},
};

struct Fixture {
    _temp: tempfile::TempDir,
    config: PathBuf,
    state: PathBuf,
    binding: Value,
}

fn private_write(path: &Path, value: &Value) {
    use std::{io::Write, os::unix::fs::OpenOptionsExt};
    let mut file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .unwrap();
    writeln!(file, "{value}").unwrap();
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let config = root.join("executor.json");
        let state = root.join("state");
        let binding = json!({"controllerId": uuid::Uuid::from_u128(1), "runnerId": uuid::Uuid::from_u128(2),
            "incarnationId": uuid::Uuid::from_u128(3), "generation": 1});
        private_write(
            &config,
            &json!({
                "controller": "https://127.0.0.1:1",
                "credentialFile": root.join("absent-credential"),
                "caFile": root.join("absent-ca"),
                "binding": binding,
                "execution": {
                    "modelsDir": root.join("absent-models"), "stateDir": state, "inventory": {},
                    "startupMs": 1, "executionMs": 1, "contactMs": 1, "stopMs": 1,
                    "responseBytes": 1, "contextTokens": 1
                }
            }),
        );
        Self {
            _temp: temp,
            config,
            state,
            binding,
        }
    }

    fn invoke(&self, operation: &str, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_canaveral-model-execution"))
            .arg(operation)
            .arg("--config")
            .arg(&self.config)
            .args(args)
            .output()
            .unwrap()
    }

    fn report(&self, operation: &str, args: &[&str], code: i32) -> Value {
        let output = self.invoke(operation, args);
        assert_eq!(output.status.code(), Some(code), "{output:?}");
        assert!(output.stderr.is_empty(), "{output:?}");
        let line = String::from_utf8(output.stdout).unwrap();
        assert_eq!(line.lines().count(), 1);
        assert!(line.ends_with('\n'));
        let report: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(report["type"], "canaveral-runtime-report");
        assert_eq!(report["version"], 1);
        assert_eq!(
            report["operation"],
            operation.trim_start_matches("--runtime-")
        );
        assert_eq!(report["platform"], std::env::consts::OS);
        assert_eq!(report["arch"], std::env::consts::ARCH);
        assert_eq!(report["dryRun"], args.contains(&"--dry-run"));
        report
    }

    fn journal(&self, digest: Option<&str>, pending: bool, unresolved: bool, live: bool) {
        let app = uuid::Uuid::from_u128(4);
        let job = uuid::Uuid::from_u128(5);
        let (state, stopped, cleanup) = if unresolved {
            ("unknown", false, "pending")
        } else {
            ("failed", true, "complete")
        };
        let mut journal = json!({
            "binding": self.binding,
            "assignment": {
                "id": job, "claimId": app, "domainId": app, "sequence": 0, "closed": false,
                "cancelRequested": false, "job": {"version":1,"applicationId":app,"id":job,"message":{
                    "type":"submit","adapter":"llama.cpp","model":"fixture","digest":format!("sha256:{}", "ab".repeat(32)),
                    "prompt":"fixture","maxTokens":1}}
            },
            "sequence":1, "pending":pending, "launchIntent":live,
            "receipt":{"version":1,"applicationId":app,"id":job,"message":{
                "type":"receipt","state":state,"cancelRequested":false,"stopped":stopped,"cleanup":cleanup}}
        });
        if let Some(digest) = digest {
            journal["runtimePackageDigest"] = json!(digest);
        }
        let key = format!("{app}:{job}");
        private_write(
            &self.state.join("receipt.json"),
            &json!({
                "current": key, "entries": { (key): journal }
            }),
        );
    }
}

#[test]
fn management_contract_is_local_and_dry_runs_do_not_create_state() {
    let fixture = Fixture::new();
    let report = fixture.report("--runtime-status", &[], 0);
    let backends = report["backends"].as_array().unwrap();
    assert_eq!(backends.len(), 4);
    assert!(backends
        .iter()
        .all(|item| item["qualified"] == false && item["installed"] == json!([])));
    assert_eq!(backends[2]["backend"], "vllm");
    assert_eq!(backends[3]["backend"], "mlx-lm");
    assert_eq!(backends[3]["state"], "unavailable");
    assert!(report.get("plan").is_none() && report.get("result").is_none());
    fixture.report(
        "--runtime-prepare",
        &["--backend", "mlx-lm", "--dry-run"],
        1,
    );
    for extra in [&["--dry-run"][..], &["--backend", "ollama"][..]] {
        let invalid = fixture.invoke("--runtime-status", extra);
        assert_eq!(invalid.status.code(), Some(2));
        assert!(invalid.stdout.is_empty() && !invalid.stderr.is_empty());
    }
    if matches!(std::env::consts::ARCH, "aarch64")
        || (cfg!(target_os = "linux") && cfg!(target_arch = "x86_64"))
    {
        let prepare = fixture.report(
            "--runtime-prepare",
            &["--backend", "llama.cpp", "--dry-run"],
            0,
        );
        assert_eq!(prepare["result"]["state"], "succeeded");
        assert!(prepare["plan"]["downloadBytes"].as_u64().unwrap() > 0);
        assert_eq!(
            prepare["plan"]["assets"][0]["bytes"],
            prepare["plan"]["downloadBytes"]
        );
        assert_eq!(
            prepare["plan"]["assets"][0]["sha256"]
                .as_str()
                .unwrap()
                .len(),
            64
        );
        fixture.report("--runtime-verify", &["--backend", "llama.cpp"], 1);
    }
    assert!(!fixture.state.exists());
    fs::set_permissions(&fixture.config, fs::Permissions::from_mode(0o644)).unwrap();
    let invalid = fixture.invoke("--runtime-status", &[]);
    assert_eq!(invalid.status.code(), Some(2));
    assert!(invalid.stdout.is_empty() && !invalid.stderr.is_empty());
}

#[test]
fn remove_preserves_referenced_versions_and_verify_reports_damage() {
    let Some(catalog) = serde_json::from_str::<Value>(include_str!("../src/runtime-pins.json"))
        .unwrap()["pins"]
        .as_array()
        .unwrap()
        .iter()
        .find(|pin| {
            pin["backend"] == "llama.cpp"
                && pin["os"] == std::env::consts::OS
                && pin["arch"] == std::env::consts::ARCH
        })
        .cloned()
    else {
        return;
    };
    let fixture = Fixture::new();
    let version = catalog["version"].as_str().unwrap();
    let tree = catalog["treeSha256"].as_str().unwrap();
    let digest = format!(
        "{:x}",
        Sha256::digest(format!("archive-v1\nllama.cpp\n{version}\n{tree}"))
    );
    let cache = fixture.state.join(format!("runtime-package.{digest}"));
    fs::create_dir(&fixture.state).unwrap();
    fs::set_permissions(&fixture.state, fs::Permissions::from_mode(0o700)).unwrap();
    private_write(&fixture.state.join("lock"), &json!(null));
    fs::create_dir(&cache).unwrap();
    fs::set_permissions(&cache, fs::Permissions::from_mode(0o700)).unwrap();
    let verify = fixture.report("--runtime-verify", &["--backend", "llama.cpp"], 1);
    assert_eq!(verify["backends"][0]["state"], "failed");
    assert_eq!(verify["backends"][0]["installed"][0]["verified"], false);
    let remove = ["--backend", "llama.cpp", "--version", version];
    for (digest, pending, unresolved, live) in [
        (Some(digest.as_str()), false, true, false),
        (Some(digest.as_str()), true, false, false),
        (Some(digest.as_str()), false, true, true),
        (None, false, true, false),
    ] {
        fixture.journal(digest, pending, unresolved, live);
        let result = fixture.report("--runtime-remove", &remove, 1);
        assert_eq!(
            result["result"],
            json!({"state":"failed","code":"runtime_in_use"})
        );
        assert_eq!(result["backends"][0]["installed"][0]["referenced"], true);
        assert!(cache.is_dir());
    }
    fixture.journal(Some(&digest), false, false, false);
    let safe_plan = fixture.report(
        "--runtime-remove",
        &["--backend", "llama.cpp", "--version", version, "--dry-run"],
        0,
    );
    assert_eq!(safe_plan["plan"], json!({"downloadBytes":0,"assets":[]}));
    assert!(cache.is_dir());
    let removed = fixture.report("--runtime-remove", &remove, 0);
    assert_eq!(removed["backends"][0]["state"], "absent");
    assert!(!cache.exists());
}
