#![cfg(unix)]
use canaveral_execution_core::model_job::{Message, State};
use canaveral_model_execution::{Assignment, Binding, Config, Control, Executor};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    net::TcpListener,
    time::Duration,
};
const APP: &str = "11111111-1111-4111-8111-111111111111";
const JOB: &str = "22222222-2222-4222-8222-222222222222";
fn digest() -> String {
    format!("sha256:{}", "ab".repeat(32))
}
fn binding() -> Binding {
    serde_json::from_value(
        json!({"controllerId":APP,"runnerId":JOB,"generation":1,"incarnationId":APP}),
    )
    .unwrap()
}
fn assignment(id: &str, prompt: &str) -> Assignment {
    Assignment{id:id.into(),claim_id:APP.into(),domain_id:APP.into(),sequence:0,closed:false,cancel_requested:false,job:serde_json::from_value(json!({"version":1,"applicationId":APP,"id":id,"message":{"type":"submit","adapter":"ollama","model":"fixture-model:1","digest":digest(),"prompt":prompt,"maxTokens":64}})).unwrap()}
}
fn config(dir: &std::path::Path) -> Config {
    let executable = std::env::current_exe().unwrap();
    let bytes = fs::read(&executable).unwrap();
    Config {
        executable,
        executable_sha256: format!("{:x}", Sha256::digest(bytes)),
        models_dir: dir.into(),
        inventory: BTreeMap::from([("fixture-model:1".into(), digest())]),
        state_dir: dir.join("state"),
        startup_ms: 3000,
        execution_ms: 1000,
        contact_ms: 1000,
        stop_ms: 1000,
        response_bytes: 262144,
        context_tokens: 8192,
    }
}
// A disposable HTTP test process, selected by the Rust test harness's `serve` filter.
// It never loads a model or invokes a shell.
#[test]
fn serve() {
    let Ok(host) = std::env::var("OLLAMA_HOST") else {
        return;
    };
    let listener = TcpListener::bind(host).unwrap();
    fs::write(
        std::path::Path::new(&std::env::var("HOME").unwrap()).join("runtime.pid"),
        std::process::id().to_string(),
    )
    .unwrap();
    for stream in listener.incoming() {
        let mut stream = stream.unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut bytes = vec![];
        let mut b = [0; 4096];
        let header;
        loop {
            let n = stream.read(&mut b).unwrap();
            if n == 0 {
                return;
            }
            bytes.extend_from_slice(&b[..n]);
            if let Some(i) = bytes.windows(4).position(|x| x == b"\r\n\r\n") {
                header = i + 4;
                break;
            }
        }
        let head = String::from_utf8_lossy(&bytes[..header]);
        let len = head
            .lines()
            .find_map(|s| {
                s.to_lowercase()
                    .strip_prefix("content-length:")
                    .and_then(|s| s.trim().parse::<usize>().ok())
            })
            .unwrap_or(0);
        while bytes.len() < header + len {
            let n = stream.read(&mut b).unwrap();
            bytes.extend_from_slice(&b[..n]);
        }
        let tags = bytes.starts_with(b"GET /api/tags ");
        let body = if tags {
            json!({"models":[{"name":"fixture-model:1","digest":digest()}]})
        } else {
            let req: serde_json::Value =
                serde_json::from_slice(&bytes[header..header + len]).unwrap();
            let prompt = req["prompt"].as_str().unwrap();
            fs::write(
                std::path::Path::new(&std::env::var("HOME").unwrap()).join("generation.started"),
                b"fixture",
            )
            .unwrap();
            if prompt == "descendant" {
                let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                    .arg("fixture_descendant")
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .unwrap();
                fs::write(
                    std::path::Path::new(&std::env::var("HOME").unwrap()).join("descendant.pid"),
                    child.id().to_string(),
                )
                .unwrap();
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                std::thread::sleep(Duration::from_secs(30));
            }
            if prompt == "hang" {
                std::thread::sleep(Duration::from_secs(30));
            }
            if prompt == "lost" {
                continue;
            }
            json!({"model":"fixture-model:1","done":true,"response":if prompt=="oversize"{"x".repeat(140000)}else{"fixture output".into()},"prompt_eval_count":5,"eval_count":2})
        };
        let body = body.to_string();
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
    }
}
#[test]
fn execution_and_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let mut e = Executor::open(cfg.clone()).unwrap();
    let a = assignment(JOB, "success");
    let j = e
        .execute(binding(), a.clone(), || Control::Continue)
        .unwrap();
    assert!(j.receipt.can_release(), "{:?}", j.receipt);
    assert!(matches!(
        j.receipt.message,
        Message::Receipt {
            state: State::Succeeded,
            ..
        }
    ));
    let exact = serde_json::to_vec(&j.receipt).unwrap();
    drop(e);
    let mut e = Executor::open(cfg.clone()).unwrap();
    assert_eq!(
        exact,
        serde_json::to_vec(&e.journal().unwrap().receipt).unwrap()
    );
    assert!(e
        .execute(binding(), a.clone(), || Control::Continue)
        .is_err());
    e.acknowledge().unwrap();
    assert!(e
        .execute(binding(), a.clone(), || Control::Continue)
        .is_err());
    let next = assignment("33333333-3333-4333-8333-333333333333", "success");
    assert!(e
        .execute(binding(), next, || Control::Continue)
        .unwrap()
        .receipt
        .can_release());
    e.acknowledge().unwrap();
    assert!(e.execute(binding(), a, || Control::Continue).is_err());
    assert!(!cfg.state_dir.join("workspace").exists());
}
#[test]
fn rejection_bounds_and_stop() {
    for mode in [
        "pin",
        "inventory",
        "oversize",
        "cancel",
        "deadline",
        "contact",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = config(dir.path());
        if mode == "pin" {
            cfg.executable_sha256 = "00".repeat(32);
        }
        if mode == "inventory" {
            cfg.inventory.clear();
        }
        if mode == "deadline" {
            cfg.execution_ms = 100;
        }
        let mut e = Executor::open(cfg.clone()).unwrap();
        let start = std::time::Instant::now();
        let prompt = if ["deadline", "cancel", "contact"].contains(&mode) {
            "hang"
        } else if mode == "oversize" {
            "oversize"
        } else {
            "success"
        };
        let j = e
            .execute(binding(), assignment(JOB, prompt), || {
                if start.elapsed() > Duration::from_millis(200) && mode == "cancel" {
                    Control::Cancel
                } else if start.elapsed() > Duration::from_millis(200) && mode == "contact" {
                    Control::Fence
                } else {
                    Control::Continue
                }
            })
            .unwrap();
        if mode == "deadline" {
            assert!(matches!(
                j.receipt.message,
                Message::Receipt {
                    state: State::Unknown,
                    ..
                }
            ));
            assert!(!j.receipt.can_release());
        } else {
            assert!(j.receipt.can_release(), "{mode}: {:?}", j.receipt);
            assert!(matches!(
                j.receipt.message,
                Message::Receipt {
                    state: State::Failed | State::Cancelled,
                    ..
                }
            ));
        }
        assert!(!cfg.state_dir.join("workspace").exists());
    }
}
#[test]
fn restart_launch_intent_never_replays() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let mut e = Executor::open(cfg.clone()).unwrap();
    e.execute(binding(), assignment(JOB, "success"), || Control::Continue)
        .unwrap();
    drop(e);
    let path = cfg.state_dir.join("receipt.json");
    let mut store: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let key = store["current"].as_str().unwrap().to_owned();
    let j = &mut store["entries"][key];
    j["pending"] = json!(false);
    j["launchIntent"] = json!(true);
    j["receipt"]["message"] = json!({"type":"receipt","state":"unknown","cancelRequested":false,"stopped":false,"cleanup":"pending"});
    fs::write(path, store.to_string()).unwrap();
    let mut e = Executor::open(cfg).unwrap();
    assert!(e.blocked());
    assert!(e.journal().unwrap().pending);
    assert!(e
        .execute(binding(), assignment(JOB, "success"), || Control::Continue)
        .is_err());
}

#[test]
fn lost_runtime_result_is_unknown_without_replay() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let mut e = Executor::open(cfg.clone()).unwrap();
    let j = e
        .execute(binding(), assignment(JOB, "lost"), || Control::Continue)
        .unwrap();
    assert!(matches!(
        j.receipt.message,
        Message::Receipt {
            state: State::Unknown,
            stopped: false,
            ..
        }
    ));
    assert!(!j.receipt.can_release());
    let exact = serde_json::to_vec(&j.receipt).unwrap();
    drop(e);
    let mut e = Executor::open(cfg).unwrap();
    assert_eq!(
        serde_json::to_vec(&e.journal().unwrap().receipt).unwrap(),
        exact
    );
    assert!(e
        .execute(binding(), assignment(JOB, "success"), || Control::Continue)
        .is_err());
}

#[test]
fn fixture_descendant() {
    if std::env::var("OLLAMA_HOST").is_ok() {
        std::thread::sleep(Duration::from_secs(30));
    }
}
#[test]
fn cancellation_fences_descendant_group() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = config(dir.path());
    let mut e = Executor::open(cfg.clone()).unwrap();
    let marker = cfg.state_dir.join("workspace/descendant.pid");
    let mut descendant = None;
    let j = e
        .execute(binding(), assignment(JOB, "descendant"), || {
            if let Ok(text) = fs::read_to_string(&marker) {
                descendant = Some(text.parse::<i32>().unwrap());
                Control::Cancel
            } else {
                Control::Continue
            }
        })
        .unwrap();
    let pid = descendant.expect("fixture descendant was not started");
    if j.receipt.can_release() {
        assert!(unsafe { libc::kill(pid, 0) } < 0);
    } else {
        assert!(matches!(
            j.receipt.message,
            Message::Receipt {
                state: State::Unknown,
                stopped: false,
                ..
            }
        ));
    }
}
