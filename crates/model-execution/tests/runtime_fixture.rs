//! Disposable protocol process; no model, interpreter, network download or shell.
use serde_json::json;
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
};
fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let option = |name: &str| args.windows(2).find(|v| v[0] == name).map(|v| v[1].clone());
    let Some(port) = option("--port") else {
        return;
    };
    let model_path = if args.first().is_some_and(|a| a == "serve") {
        args.get(1).cloned()
    } else {
        option("--model")
    }
    .unwrap();
    let alias = option("--alias").or_else(|| option("--served-model-name"));
    let model = alias.clone().unwrap_or_else(|| "default_model".into());
    let inventory_id = alias.unwrap_or(model_path);
    let key = option("--api-key-file")
        .map(|path| fs::read_to_string(path).unwrap())
        .or_else(|| std::env::var("VLLM_API_KEY").ok());
    let listener = TcpListener::bind(format!("127.0.0.1:{port}")).unwrap();
    for stream in listener.incoming() {
        let mut stream = stream.unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(2)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut buffer = [0; 4096];
        let header = loop {
            let n = stream.read(&mut buffer).unwrap();
            if n == 0 {
                return;
            }
            bytes.extend_from_slice(&buffer[..n]);
            if let Some(index) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                break index + 4;
            }
        };
        let head = String::from_utf8_lossy(&bytes[..header]).to_lowercase();
        if let Some(key) = &key {
            assert!(head.contains(&format!("authorization: bearer {key}")));
        }
        let length = head
            .lines()
            .find_map(|v| {
                v.strip_prefix("content-length:")
                    .and_then(|v| v.trim().parse::<usize>().ok())
            })
            .unwrap_or(0);
        while bytes.len() < header + length {
            let n = stream.read(&mut buffer).unwrap();
            if n == 0 {
                return;
            }
            bytes.extend_from_slice(&buffer[..n]);
        }
        let value = if bytes.starts_with(b"GET /health ") {
            json!({"status":"ok"})
        } else if bytes.starts_with(b"GET /v1/models ") {
            json!({"data":[{"id":inventory_id}]})
        } else {
            assert!(bytes.starts_with(b"POST /v1/completions "));
            let body: serde_json::Value =
                serde_json::from_slice(&bytes[header..header + length]).unwrap();
            assert_eq!(body["model"], model);
            assert_eq!(body["stream"], false);
            assert_eq!(body["max_tokens"], 64);
            let prompt = body["prompt"].as_str().unwrap();
            if prompt == "lost" {
                continue;
            }
            if prompt == "hang" {
                std::thread::sleep(std::time::Duration::from_secs(30));
            }
            let mut response = json!({"model":if prompt=="identity"{"foreign-model"}else{&model},"choices":[{"text":"owned fixture output","finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}});
            if prompt == "usage" {
                response.as_object_mut().unwrap().remove("usage");
            }
            response
        };
        let encoded = value.to_string();
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            encoded.len(),
            encoded
        );
    }
}
