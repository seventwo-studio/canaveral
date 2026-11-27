//! Local-only GGUF import into a disposable Ollama store.
use crate::{decode, runtime_backend::open_model_file, runtime_package::hash_valid, Result};
use reqwest::blocking::{Body, Client};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::Read,
    os::unix::fs::MetadataExt,
    path::Path,
};

pub(crate) const ALIAS: &str = "canaveral-local:run";
const MANIFEST: &str = "manifests-v2/ollama.com/library/canaveral-local/run";
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MODEL: &str = "application/vnd.ollama.image.model";

pub(super) fn create(
    client: &Client,
    base: &str,
    pid: u32,
    port: u16,
    file: File,
    digest: &str,
) -> Result<()> {
    let size = file.metadata().map_err(|_| "model unavailable")?.len();
    let owned = || {
        crate::socket_owner::owned(pid, port)
            .then_some(())
            .ok_or("runtime socket ownership lost")
    };
    owned()?;
    let response = client
        .post(format!("{base}/api/blobs/{digest}"))
        .body(Body::sized(file, size))
        .send()
        .map_err(|_| "Ollama blob upload failed")?;
    if !response.status().is_success() {
        return Err("Ollama blob upload rejected");
    }
    owned()?;
    let response = client
        .post(format!("{base}/api/create"))
        .json(
            &serde_json::json!({"model": ALIAS, "files": {"model.gguf": digest}, "stream": false}),
        )
        .send()
        .map_err(|_| "Ollama model import failed")?;
    let result =
        decode(response, MAX_MANIFEST_BYTES).map_err(|_| "Ollama model import rejected")?;
    if result["status"] != "success" {
        return Err("Ollama model import incomplete");
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u32,
    media_type: String,
    config: Layer,
    layers: Vec<Layer>,
    #[serde(default)]
    manifests: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Layer {
    media_type: String,
    digest: String,
    size: u64,
}

fn bare_digest(digest: &str) -> Result<&str> {
    digest
        .strip_prefix("sha256:")
        .filter(|value| hash_valid(value))
        .ok_or("invalid Ollama blob digest")
}

pub(super) fn verify(store: &Path, expected: &str) -> Result<String> {
    let manifest = store.join(MANIFEST);
    crate::private::walk(manifest.parent().ok_or("Ollama manifest unavailable")?)?;
    let target = fs::read_link(&manifest).map_err(|_| "Ollama manifest link unavailable")?;
    // Validate the engine-created link lexically, then open only the blob by its digest.
    let filename = target
        .file_name()
        .and_then(|item| item.to_str())
        .ok_or("invalid Ollama manifest link")?;
    let basename = filename
        .strip_prefix("sha256-")
        .filter(|value| hash_valid(value))
        .ok_or("invalid Ollama manifest link")?;
    if target != Path::new("../../../../blobs").join(filename) {
        return Err("invalid Ollama manifest link");
    }
    let blobs = store.join("blobs");
    let mut bytes = Vec::new();
    open_model_file(&blobs.join(filename))?
        .take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Ollama manifest unavailable")?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES
        || format!("{:x}", Sha256::digest(&bytes)) != basename
    {
        return Err("Ollama manifest integrity mismatch");
    }
    let value: crate::json::Unique =
        serde_json::from_slice(&bytes).map_err(|_| "invalid Ollama manifest")?;
    let manifest: Manifest =
        serde_json::from_value(value.0).map_err(|_| "invalid Ollama manifest")?;
    if manifest.schema_version != 2
        || manifest.media_type != "application/vnd.docker.distribution.manifest.v2+json"
        || !manifest.manifests.is_empty()
        || manifest.config.media_type != "application/vnd.docker.container.image.v1+json"
    {
        return Err("invalid Ollama manifest");
    }
    let mut model_seen = false;
    for layer in std::iter::once(&manifest.config).chain(&manifest.layers) {
        let hash = bare_digest(&layer.digest)?;
        if layer.media_type == MODEL {
            if model_seen || layer.digest != expected {
                return Err("Ollama GGUF identity mismatch");
            }
            model_seen = true;
        } else if !matches!(
            layer.media_type.as_str(),
            "application/vnd.docker.container.image.v1+json"
                | "application/vnd.ollama.image.template"
                | "application/vnd.ollama.image.params"
                | "application/vnd.ollama.image.license"
                | "application/vnd.ollama.image.system"
        ) {
            return Err("unexpected Ollama model layer");
        }
        let path = blobs.join(format!("sha256-{hash}"));
        let metadata = open_model_file(&path)?
            .metadata()
            .map_err(|_| "Ollama blob unavailable")?;
        if metadata.len() != layer.size || metadata.uid() != unsafe { libc::geteuid() } {
            return Err("Ollama blob identity mismatch");
        }
        crate::runtime_backend::verify_file(&path, hash)
            .map_err(|_| "Ollama blob integrity mismatch")?;
    }
    if !model_seen {
        return Err("Ollama GGUF layer missing");
    }
    Ok(format!("sha256:{basename}"))
}
