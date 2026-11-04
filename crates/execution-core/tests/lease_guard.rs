use canaveral_execution_core::lease_guard::{Clock, LeaseGuard, Result};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct State(PathBuf);
impl State {
    fn new() -> Self {
        loop {
            let path = std::env::temp_dir().join(format!(
                "canaveral-rust-guard-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&path) {
                Ok(()) => return Self(path),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("{error}"),
            }
        }
    }
}
impl Drop for State {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn clock() -> Clock {
    Clock {
        wall: 1000.0,
        monotonic: 10.0,
    }
}
fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../fixtures/migration/lease_guard.json")).unwrap()
}

#[test]
fn shared_python_reference_traces() -> Result<()> {
    let fixture = fixture();
    for case in fixture["cases"].as_array().unwrap() {
        let state = State::new();
        if case["identity"] == true {
            fs::write(state.0.join("identity.json"), "{}")?;
        }
        let mut guard = Some(LeaseGuard::open(&state.0, clock())?);
        for step in case["steps"].as_array().unwrap() {
            let now = Clock {
                wall: step["wall"].as_f64().unwrap_or(1000.0),
                monotonic: step["mono"].as_f64().unwrap_or(10.0),
            };
            let mut machine = fixture["machine"].clone();
            if let Some(patch) = step["lease"].as_object() {
                for (key, value) in patch {
                    machine["lease"][key] = value.clone();
                }
            }
            let id = machine["id"].as_str().unwrap();
            let lease = fixture["machine"]["lease"]["id"].as_str().unwrap();
            let result = (|| -> Result<Value> {
                if step["op"] == "reopen" {
                    drop(guard.take());
                    guard = Some(LeaseGuard::open(&state.0, now)?);
                    return Ok(Value::Null);
                }
                let guard = guard.as_mut().unwrap();
                Ok(match step["op"].as_str().unwrap() {
                    "observe" => {
                        guard.observe(
                            std::slice::from_ref(&machine),
                            step["rtt"].as_f64().unwrap_or(0.0),
                            now,
                        )?;
                        Value::Null
                    }
                    "empty" => {
                        guard.observe(&[], 0.0, now)?;
                        Value::Null
                    }
                    "allowed" => json!(guard.allowed(id, now)?),
                    "never_started" => json!(guard.never_started(id, lease)?),
                    "begin" => {
                        guard.begin_execution(id, lease, now)?;
                        Value::Null
                    }
                    "retire" => {
                        guard.retire(id, lease, machine["leaseCleanup"]["id"].as_str().unwrap())?;
                        Value::Null
                    }
                    "authorization" => serde_json::to_value(guard.authorization(id, lease, now)?)?,
                    "assignments" => json!(guard.assignments(&[machine.clone()], now)?),
                    "fenced" => json!(guard.fenced_machines(now)?),
                    _ => panic!("Unknown trace operation"),
                })
            })();
            if step["error"] == true {
                assert!(result.is_err(), "{}: {step}", case["name"]);
            } else {
                assert_eq!(
                    result?,
                    step.get("expected").cloned().unwrap_or(Value::Null),
                    "{}: {step}",
                    case["name"]
                );
            }
        }
        if case["wire"] == true {
            let mut expected = fixture["initialRecord"].clone();
            expected["machine"] = fixture["machine"].clone();
            let disk: Value =
                serde_json::from_slice(&fs::read(state.0.join("lease-execution.json"))?)?;
            assert_eq!(
                disk,
                json!({ fixture["machine"]["id"].as_str().unwrap(): expected })
            );
        }
    }
    Ok(())
}

#[test]
fn exclusive_host_lock_and_complete_assignment_metadata_survive_reopening() -> Result<()> {
    let state = State::new();
    let machine = fixture()["machine"].clone();
    let mut guard = LeaseGuard::open(&state.0, clock())?;
    assert!(LeaseGuard::open(&state.0, clock()).is_err());
    guard.observe(std::slice::from_ref(&machine), 0.0, clock())?;
    let disk: Value = serde_json::from_slice(&fs::read(state.0.join("lease-execution.json"))?)?;
    assert_eq!(disk[machine["id"].as_str().unwrap()]["machine"], machine);
    drop(guard);
    let mut reopened = LeaseGuard::open(&state.0, clock())?;
    assert_eq!(reopened.assignments(&[], clock())?[0], machine);
    let ordinary = json!({"id":"99999999-8888-4777-8666-555555555555","desired":"running"});
    assert!(reopened
        .assignments(std::slice::from_ref(&ordinary), clock())?
        .contains(&ordinary));
    Ok(())
}

#[test]
fn failed_execution_marker_publication_fences_the_instance_without_effect_replay() -> Result<()> {
    let state = State::new();
    let machine = fixture()["machine"].clone();
    let mut guard = LeaseGuard::open(&state.0, clock())?;
    guard.observe(std::slice::from_ref(&machine), 0.0, clock())?;
    let path = state.0.join("lease-execution.json");
    fs::rename(&path, state.0.join("saved.json"))?;
    fs::create_dir(&path)?;
    let id = machine["id"].as_str().unwrap();
    let lease = machine["lease"]["id"].as_str().unwrap();
    assert!(guard.begin_execution(id, lease, clock()).is_err());
    assert!(guard.allowed(id, clock()).is_err());
    assert!(guard.authorization(id, lease, clock()).is_err());
    assert!(guard.observe(&[machine], 0.0, clock()).is_err());
    assert!(fs::read_dir(&state.0)?.all(|e| !e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .ends_with(".tmp")));
    Ok(())
}

#[test]
fn corrupt_journals_and_invalid_reports_never_become_empty_authorization() -> Result<()> {
    let state = State::new();
    fs::write(state.0.join("lease-execution.json"), b"{broken")?;
    assert!(LeaseGuard::open(&state.0, clock()).is_err());
    fs::remove_file(state.0.join("lease-execution.json"))?;
    let mut guard = LeaseGuard::open(&state.0, clock())?;
    let machine = fixture()["machine"].clone();
    assert!(guard
        .observe(std::slice::from_ref(&machine), -1.0, clock())
        .is_err());
    assert!(guard.observe(&[machine], f64::NAN, clock()).is_err());
    assert!(!state.0.join("lease-execution.json").exists());
    Ok(())
}
