use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;

fn main() {
    println!("cargo:rerun-if-changed=src/socket_owner.c");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("src/socket_owner.c")
            .warnings_into_errors(true)
            .compile("model_socket_owner");
    }
    if let Err(error) = check_qualified_table() {
        panic!("runtime-qualified.json: {error}. Run node script/qualification.mjs sync.");
    }
}

fn read(path: &Path) -> Result<Value, String> {
    println!("cargo:rerun-if-changed={}", path.display());
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))
}

// Matches canonical() in script/qualification.mjs: sorted keys, no whitespace.
fn canonical(value: &Value) -> String {
    match value {
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        Value::Object(map) => {
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort();
            let fields: Vec<_> = keys
                .into_iter()
                .map(|key| format!("{}:{}", Value::from(key.as_str()), canonical(&map[key])))
                .collect();
            format!("{{{}}}", fields.join(","))
        }
        other => other.to_string(),
    }
}

fn hex(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

// The compiled table must be exactly what the reviewed promotions generate, and
// every model-engine entry must name an exact pin in the compiled catalog.
fn check_qualified_table() -> Result<(), String> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let table = read(&dir.join("src/runtime-qualified.json"))?;
    let catalog = read(&dir.join("src/runtime-pins.json"))?;
    if table["schema"] != "canaveral-qualified-pins" || table["version"] != 1 {
        return Err("unknown table schema".into());
    }
    let pins = table["pins"].as_array().ok_or("pins must be an array")?;
    for entry in pins {
        let identity = &entry["identity"];
        let version = identity["version"]
            .as_str()
            .ok_or("identity needs a version")?;
        let expected = format!("{version}-{}", &hex(canonical(identity))[..24]);
        if entry["pinId"] != expected.as_str() {
            return Err(format!(
                "pinId {} does not match its identity",
                entry["pinId"]
            ));
        }
        let backend = entry["backend"].as_str().ok_or("entry needs a backend")?;
        if !["ollama", "llama.cpp", "vllm", "mlx-lm"].contains(&backend) {
            continue;
        }
        if backend != "llama.cpp"
            || entry["acceleration"] != "cpu"
            || entry["executionMode"] != "cpu-generation"
        {
            return Err(format!("{backend} {expected} is not a promotable scope"));
        }
        let pin = catalog["pins"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|pin| {
                pin["backend"] == backend
                    && pin["os"] == entry["os"]
                    && pin["arch"] == entry["arch"]
            })
            .ok_or_else(|| format!("no catalog pin for {expected}"))?;
        let tree = pin["treeSha256"].as_str().unwrap_or_default();
        let package = hex(format!("archive-v1\n{backend}\n{version}\n{tree}"));
        let exact = serde_json::json!({
            "version": pin["version"], "url": pin["url"], "sha256": pin["sha256"],
            "treeSha256": pin["treeSha256"], "packageDigest": package,
        });
        if *identity != exact {
            return Err(format!("{expected} is not the exact catalog pin"));
        }
    }
    // In a source checkout, also require the table to be generated from the promotions.
    let promotions = dir.join("../../qualification/promotions.json");
    if promotions.exists() {
        let source = read(&promotions)?;
        let mut generated: Vec<String> = source["promotions"]
            .as_array()
            .ok_or("promotions must be an array")?
            .iter()
            .map(|entry| {
                let mut pin = serde_json::json!({
                    "backend": entry["backend"], "pinId": entry["pinId"], "identity": entry["identity"],
                });
                for (key, value) in entry["scope"].as_object().into_iter().flatten() {
                    pin[key] = value.clone();
                }
                canonical(&pin)
            })
            .collect();
        let mut compiled: Vec<String> = pins.iter().map(canonical).collect();
        generated.sort();
        compiled.sort();
        if generated != compiled {
            return Err("table does not match qualification/promotions.json".into());
        }
    }
    Ok(())
}
