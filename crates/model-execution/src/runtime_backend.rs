//! Fixed launch/protocol strategies for private, Canaveral-owned runtimes.
//! HTTP model names are not artifact integrity evidence.
use crate::{
    runtime_policy::Acceleration, Config, GenerationResult, Message, ModelJob, Result, Usage,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path},
    process::Command,
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
pub enum Backend {
    #[default]
    #[serde(rename = "ollama")]
    Ollama,
    #[serde(rename = "llama.cpp")]
    LlamaCpp,
    #[serde(rename = "vllm")]
    Vllm,
    #[serde(rename = "mlx")]
    Mlx,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelFiles {
    pub path: String,
    pub files: BTreeMap<String, String>,
}
impl Backend {
    pub fn adapter(self) -> &'static str {
        match self {
            Self::Ollama => "ollama",
            Self::LlamaCpp => "llama.cpp",
            Self::Vllm => "vllm",
            Self::Mlx => "mlx",
        }
    }
    pub fn authenticated(self) -> bool {
        matches!(self, Self::LlamaCpp | Self::Vllm)
    }
    pub fn validate(self, config: &Config) -> Result<()> {
        if self == Self::Mlx && !(cfg!(target_os = "macos") && cfg!(target_arch = "aarch64")) {
            return Err("MLX requires Apple silicon macOS");
        }
        if self == Self::Vllm && !cfg!(target_os = "linux") {
            return Err("vLLM requires Linux");
        }
        if config.acceleration == Acceleration::Cpu && matches!(self, Self::Vllm | Self::Mlx) {
            return Err("CPU policy is not supported by this backend");
        }
        if self != Self::Ollama
            && config.runtime_packages.is_empty()
            && (!config.executable.as_os_str().is_empty()
                || crate::runtime_archive::host_pin(self).is_none())
        {
            return Err("backend requires a managed runtime package");
        }
        if (self != Self::Ollama || !config.model_files.is_empty())
            && (config.inventory.len() != config.model_files.len()
                || config
                    .inventory
                    .keys()
                    .any(|key| !config.model_files.contains_key(key)))
        {
            return Err("every backend model requires a pinned local artifact");
        }
        if self == Self::Ollama
            && !config.model_files.is_empty()
            && (!config.executable.as_os_str().is_empty()
                || !config.runtime_packages.is_empty()
                || crate::runtime_archive::host_pin(self).is_none())
        {
            return Err("GGUF import requires the catalog Ollama package");
        }
        Ok(())
    }
    pub fn verify_models(self, config: &Config) -> Result<()> {
        for (label, artifact) in &config.model_files {
            relative(&artifact.path)?;
            if artifact.files.is_empty() || artifact.files.len() > 100_000 {
                return Err("invalid model manifest");
            }
            let root = config.models_dir.join(&artifact.path);
            if matches!(self, Self::LlamaCpp | Self::Ollama) {
                if artifact.files.len() != 1
                    || !artifact.files.contains_key(&artifact.path)
                    || !artifact.path.ends_with(".gguf")
                {
                    return Err("backend requires one pinned GGUF file");
                }
                let expected = &artifact.files[&artifact.path];
                verify_file(&root, expected)?;
                if config.inventory.get(label) != Some(&format!("sha256:{expected}")) {
                    return Err("model digest mismatch");
                }
            } else {
                if !root.is_dir() {
                    return Err("model snapshot directory required");
                }
                let mut actual = BTreeMap::new();
                collect(&root, &root, &mut actual)?;
                if actual != artifact.files {
                    return Err("model snapshot integrity mismatch");
                }
                if !actual.contains_key("config.json")
                    || !actual.keys().any(|name| name.ends_with(".safetensors"))
                {
                    return Err("incomplete model snapshot");
                }
                let canonical =
                    serde_json::to_vec(&actual).map_err(|_| "invalid model manifest")?;
                if config.inventory.get(label)
                    != Some(&format!("sha256:{:x}", Sha256::digest(canonical)))
                {
                    return Err("model digest mismatch");
                }
            }
        }
        Ok(())
    }
    pub fn configure(
        self,
        cmd: &mut Command,
        config: &Config,
        model: &str,
        port: u16,
        key: &str,
        key_file: &Path,
    ) -> Result<()> {
        let host = format!("127.0.0.1:{port}");
        match self {
            Self::Ollama => {
                cmd.arg("serve")
                    .env("OLLAMA_HOST", host)
                    .env("OLLAMA_MODELS", &config.models_dir)
                    .env("OLLAMA_NO_CLOUD", "1")
                    .env("OLLAMA_NOPRUNE", "1")
                    .env("OLLAMA_NUM_PARALLEL", "1")
                    .env("OLLAMA_MAX_LOADED_MODELS", "1")
                    .env("OLLAMA_CONTEXT_LENGTH", config.context_tokens.to_string());
                config.acceleration.configure(cmd);
            }
            _ => {
                let artifact = config
                    .model_files
                    .get(model)
                    .ok_or("model artifact unavailable")?;
                relative(&artifact.path)?;
                let path = config.models_dir.join(&artifact.path);
                // No remote identifiers, inherited search path, trust-remote-code or download flags.
                cmd.env("HF_HUB_OFFLINE", "1")
                    .env("TRANSFORMERS_OFFLINE", "1")
                    .env("HF_HUB_DISABLE_TELEMETRY", "1")
                    .env("DO_NOT_TRACK", "1");
                match self {
                    Self::LlamaCpp => {
                        cmd.arg("--model")
                            .arg(path)
                            .arg("--alias")
                            .arg(model)
                            .args(["--host", "127.0.0.1", "--port"])
                            .arg(port.to_string())
                            .arg("--ctx-size")
                            .arg(config.context_tokens.to_string())
                            .args(["--parallel", "1", "--no-webui", "--api-key-file"])
                            .arg(key_file);
                        if config.acceleration == Acceleration::Cpu {
                            cmd.args(["--device", "none", "--n-gpu-layers", "0"]);
                        }
                    }
                    Self::Vllm => {
                        cmd.arg("serve")
                            .arg(path)
                            .arg("--served-model-name")
                            .arg(model)
                            .args(["--host", "127.0.0.1", "--port"])
                            .arg(port.to_string())
                            .arg("--max-model-len")
                            .arg(config.context_tokens.to_string())
                            .args([
                                "--max-num-seqs",
                                "1",
                                "--generation-config",
                                "vllm",
                                "--disable-log-requests",
                            ])
                            .env("VLLM_API_KEY", key)
                            .env("VLLM_NO_USAGE_STATS", "1");
                    }
                    Self::Mlx => {
                        cmd.arg("--model")
                            .arg(path)
                            .args(["--host", "127.0.0.1", "--port"])
                            .arg(port.to_string());
                    }
                    Self::Ollama => unreachable!(),
                }
            }
        }
        Ok(())
    }
    pub fn inventory_route(self) -> &'static str {
        if self == Self::Ollama {
            "/api/tags"
        } else {
            "/v1/models"
        }
    }
    pub fn generation_route(self) -> &'static str {
        if self == Self::Ollama {
            "/api/generate"
        } else {
            "/v1/completions"
        }
    }
    pub(super) fn alias(self, model: &str) -> &str {
        if self == Self::Mlx {
            "default_model"
        } else {
            model
        }
    }
    pub fn inventory_matches(
        self,
        config: &Config,
        value: &serde_json::Value,
        model: &str,
        digest: &str,
    ) -> bool {
        if self == Self::Ollama {
            return value
                .get("models")
                .and_then(|m| m.as_array())
                .is_some_and(|models| {
                    models.iter().any(|v| {
                        v.get("name").and_then(|v| v.as_str()) == Some(model)
                            && v.get("digest")
                                .and_then(|v| v.as_str())
                                .is_some_and(|d| d == digest || format!("sha256:{d}") == digest)
                    })
                });
        }
        let expected = if self == Self::Mlx {
            config.model_files.get(model).map(|a| {
                config
                    .models_dir
                    .join(&a.path)
                    .to_string_lossy()
                    .into_owned()
            })
        } else {
            Some(model.to_owned())
        };
        value
            .get("data")
            .and_then(|v| v.as_array())
            .is_some_and(|rows| {
                rows.iter()
                    .any(|v| v.get("id").and_then(|v| v.as_str()) == expected.as_deref())
            })
    }
    pub(super) fn request(
        self,
        config: &Config,
        job: &ModelJob,
        runtime_model: &str,
    ) -> Result<serde_json::Value> {
        let Message::Submit {
            prompt, max_tokens, ..
        } = &job.message
        else {
            return Err("submission required");
        };
        Ok(if self == Self::Ollama {
            serde_json::json!({"model":runtime_model,"prompt":prompt,"stream":false,"keep_alive":0,"options":config.acceleration.options(config.context_tokens,*max_tokens)})
        } else {
            serde_json::json!({"model":runtime_model,"prompt":prompt,"max_tokens":max_tokens,"stream":false,"n":1})
        })
    }
    pub(super) fn result(
        self,
        job: &ModelJob,
        runtime_model: &str,
        value: &serde_json::Value,
    ) -> Result<GenerationResult> {
        let Message::Submit {
            model, max_tokens, ..
        } = &job.message
        else {
            return Err("submission required");
        };
        if value.get("model").and_then(|v| v.as_str()) != Some(runtime_model) {
            return Err("invalid generation identity");
        }
        let (text, usage, input, output) = if self == Self::Ollama {
            if value.get("done") != Some(&serde_json::Value::Bool(true)) {
                return Err("incomplete generation");
            }
            (
                value.get("response"),
                value,
                "prompt_eval_count",
                "eval_count",
            )
        } else {
            let choices = value
                .get("choices")
                .and_then(|v| v.as_array())
                .filter(|v| v.len() == 1)
                .ok_or("invalid generation choices")?;
            if !matches!(
                choices[0].get("finish_reason").and_then(|v| v.as_str()),
                Some("stop" | "length")
            ) {
                return Err("incomplete generation");
            }
            (
                choices[0].get("text"),
                value.get("usage").ok_or("missing token measurement")?,
                "prompt_tokens",
                "completion_tokens",
            )
        };
        let count = |key| {
            usage
                .get(key)
                .and_then(|v| v.as_u64())
                .filter(|n| *n <= 2147483648)
                .ok_or("missing token measurement")
        };
        let result = GenerationResult {
            model: model.clone(),
            text: text.and_then(|v| v.as_str()).ok_or("missing text")?.into(),
            usage: Usage {
                input_tokens: count(input)?,
                output_tokens: count(output)?,
            },
        };
        if result.usage.output_tokens > *max_tokens {
            return Err("output token budget exceeded");
        }
        Ok(result)
    }
}
fn relative(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 4096
        || value.contains('\\')
        || value.bytes().any(|b| b.is_ascii_control())
        || !Path::new(value)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
        || value
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
    {
        return Err("safe relative model path required");
    }
    Ok(())
}
pub(super) fn open_model_file(path: &Path) -> Result<fs::File> {
    // Resolve trusted parents, then refuse a linked final component. The operator
    // must still keep the inventory immutable throughout the owned runtime's use.
    crate::private::walk(path.parent().ok_or("model parent unavailable")?)?;
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| "model unavailable")?;
    let metadata = file.metadata().map_err(|_| "model unavailable")?;
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.mode() & 0o022 != 0
        || !(metadata.uid() == 0 || metadata.uid() == unsafe { libc::geteuid() })
    {
        return Err("unsafe model file");
    }
    Ok(file)
}
fn hash_file(path: &Path) -> Result<String> {
    let mut file = open_model_file(path)?;
    let before = file.metadata().map_err(|_| "model unavailable")?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let count = file.read(&mut buffer).map_err(|_| "model read failed")?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    let after = file.metadata().map_err(|_| "model unavailable")?;
    if before.len() != after.len()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
        || before.ctime() != after.ctime()
        || before.ctime_nsec() != after.ctime_nsec()
    {
        return Err("model changed while hashing");
    }
    Ok(format!("{:x}", hash.finalize()))
}
pub(super) fn verify_file(path: &Path, expected: &str) -> Result<()> {
    if !crate::runtime_package::hash_valid(expected) || hash_file(path)? != expected {
        return Err("model file integrity mismatch");
    }
    Ok(())
}
fn collect(root: &Path, directory: &Path, result: &mut BTreeMap<String, String>) -> Result<()> {
    for entry in fs::read_dir(directory).map_err(|_| "model unavailable")? {
        let path = entry.map_err(|_| "model unavailable")?.path();
        let metadata = fs::symlink_metadata(&path).map_err(|_| "model unavailable")?;
        if metadata.is_dir() {
            collect(root, &path, result)?;
        } else if metadata.is_file() {
            if result.len() >= 100_000 {
                return Err("model manifest bound exceeded");
            }
            let name = path
                .strip_prefix(root)
                .ok()
                .and_then(Path::to_str)
                .ok_or("invalid model path")?
                .to_owned();
            relative(&name)?;
            result.insert(name, hash_file(&path)?);
        } else {
            return Err("unsafe model file");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Assignment, Binding, Control, Executor};
    use std::{os::unix::fs::PermissionsExt, path::PathBuf};
    const APP: &str = "11111111-1111-4111-8111-111111111111";
    const JOB: &str = "22222222-2222-4222-8222-222222222222";
    fn fixture_binary() -> PathBuf {
        let directory = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();
        fs::read_dir(directory)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("runtime_fixture-")
                    && p.extension().is_none()
                    && fs::metadata(p).unwrap().permissions().mode() & 0o111 != 0
            })
            .max_by_key(|p| fs::metadata(p).unwrap().modified().unwrap())
            .expect("build disposable runtime fixture with cargo test --all-targets --no-run first")
    }
    fn config(root: &Path, backend: Backend) -> Config {
        let binary = fixture_binary();
        let package = root.join("package");
        fs::create_dir_all(&package).unwrap();
        fs::copy(&binary, package.join("runtime")).unwrap();
        let models = root.join("models");
        fs::create_dir_all(&models).unwrap();
        let mut manifest = BTreeMap::new();
        let (path, digest) = if backend == Backend::LlamaCpp {
            fs::write(models.join("model.gguf"), b"fixture GGUF, no weights").unwrap();
            let hash = hash_file(&models.join("model.gguf")).unwrap();
            manifest.insert("model.gguf".into(), hash.clone());
            ("model.gguf", format!("sha256:{hash}"))
        } else {
            fs::create_dir(models.join("snapshot")).unwrap();
            for (name, bytes) in [
                ("config.json", b"{}".as_slice()),
                ("weights.safetensors", b"fixture, no weights".as_slice()),
            ] {
                fs::write(models.join("snapshot").join(name), bytes).unwrap();
                manifest.insert(name.into(), format!("{:x}", Sha256::digest(bytes)));
            }
            (
                "snapshot",
                format!(
                    "sha256:{:x}",
                    Sha256::digest(serde_json::to_vec(&manifest).unwrap())
                ),
            )
        };
        Config {
            backend,
            acceleration: Default::default(),
            model_files: BTreeMap::from([(
                "fixture-model:1".into(),
                ModelFiles {
                    path: path.into(),
                    files: manifest,
                },
            )]),
            executable: Default::default(),
            executable_sha256: String::new(),
            runtime_packages: vec![crate::runtime_package::RuntimePackage {
                os: std::env::consts::OS.into(),
                arch: std::env::consts::ARCH.into(),
                root: package,
                base_url: None,
                executables: vec![],
                entrypoint: "runtime".into(),
                files: BTreeMap::from([("runtime".into(), hash_file(&binary).unwrap())]),
            }],
            models_dir: models,
            inventory: BTreeMap::from([("fixture-model:1".into(), digest)]),
            state_dir: root.join("state"),
            startup_ms: 3000,
            execution_ms: 1000,
            contact_ms: 1000,
            stop_ms: 1000,
            response_bytes: 262144,
            context_tokens: 8192,
        }
    }
    fn assignment(config: &Config, prompt: &str) -> Assignment {
        serde_json::from_value(serde_json::json!({"id":JOB,"claimId":APP,"domainId":APP,"sequence":0,"closed":false,"cancelRequested":false,"job":{"version":1,"applicationId":APP,"id":JOB,"message":{"type":"submit","adapter":config.backend.adapter(),"model":"fixture-model:1","digest":config.inventory["fixture-model:1"],"prompt":prompt,"maxTokens":64}}})).unwrap()
    }
    fn binding() -> Binding {
        serde_json::from_value(serde_json::json!({"controllerId":APP,"runnerId":JOB,"generation":1,"incarnationId":APP})).unwrap()
    }
    #[test]
    fn owned_http_protocols_measure_usage_and_cleanup_without_qualifying_native_support() {
        for backend in [Backend::LlamaCpp, Backend::Vllm, Backend::Mlx] {
            for prompt in ["success", "identity", "usage", "lost"] {
                let directory = tempfile::tempdir().unwrap();
                let root = directory.path().canonicalize().unwrap();
                let config = config(&root, backend);
                // Host compatibility remains enforced by production open(). This test injects
                // a disposable native HTTP process to exercise every wire strategy on any host.
                let mut initial = config.clone();
                initial.backend = Backend::Ollama;
                initial.model_files.clear();
                let mut executor = Executor::open(initial).unwrap();
                executor.config = config.clone();
                let job = assignment(&config, prompt);
                let receipt = executor
                    .execute(binding(), job, || Control::Continue)
                    .unwrap();
                let Message::Receipt { state, result, .. } = &receipt.receipt.message else {
                    panic!()
                };
                assert_eq!(
                    *state,
                    match prompt {
                        "success" => crate::State::Succeeded,
                        "lost" => crate::State::Unknown,
                        _ => crate::State::Failed,
                    },
                    "{backend:?} {prompt}"
                );
                if let Some(result) = result {
                    assert_eq!(result.model, "fixture-model:1");
                    assert_eq!(result.text, "owned fixture output");
                    assert_eq!(result.usage.input_tokens, 5);
                    assert_eq!(result.usage.output_tokens, 2);
                }
                assert!(receipt.stop_confirmed);
                assert!(receipt.cleanup_confirmed);
                assert!(!config.state_dir.join("workspace").exists());
            }
        }
    }
    #[test]
    fn model_manifests_pin_bytes_and_reject_paths_missing_files_and_tampering() {
        for backend in [Backend::LlamaCpp, Backend::Vllm, Backend::Mlx] {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path().canonicalize().unwrap();
            let mut config = config(&root, backend);
            assert!(backend.verify_models(&config).is_ok());
            config.model_files.get_mut("fixture-model:1").unwrap().path = "../escape".into();
            assert!(backend.verify_models(&config).is_err());
            config.model_files.get_mut("fixture-model:1").unwrap().path =
                if backend == Backend::LlamaCpp {
                    "model.gguf"
                } else {
                    "snapshot"
                }
                .into();
            let file = if backend == Backend::LlamaCpp {
                config.models_dir.join("model.gguf")
            } else {
                config.models_dir.join("snapshot/config.json")
            };
            fs::write(file, b"changed").unwrap();
            assert!(backend.verify_models(&config).is_err());
        }
    }
    #[test]
    fn cpu_policy_rejects_backends_without_cpu_enforcement_and_paths_remain_local() {
        for path in [
            "",
            "../model",
            "/absolute",
            "x/../model",
            "x//file",
            "x/./file",
            "x\\file",
        ] {
            assert!(relative(path).is_err());
        }
        for backend in [Backend::Vllm, Backend::Mlx] {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path().canonicalize().unwrap();
            let mut config = config(&root, backend);
            config.acceleration = Acceleration::Cpu;
            assert!(backend.validate(&config).is_err());
        }
    }
}
