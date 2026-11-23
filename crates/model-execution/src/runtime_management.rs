//! Local runtime management uses the executor's state lock and package store.
use crate::{
    load_history, private::Directory, runtime_archive as archive, runtime_backend::Backend, Config,
    PackageReferences, Result,
};
use serde_json::{json, Value};
use std::{
    path::{Component, Path},
    time::{Duration, Instant},
};

const BACKENDS: [Backend; 4] = [
    Backend::Ollama,
    Backend::LlamaCpp,
    Backend::Vllm,
    Backend::Mlx,
];

fn name(backend: Backend) -> &'static str {
    if backend == Backend::Mlx {
        "mlx-lm"
    } else {
        backend.adapter()
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Operation {
    Status,
    Prepare,
    Verify,
    Remove,
}
impl Operation {
    fn name(self) -> &'static str {
        match self {
            Self::Status => "status",
            Self::Prepare => "prepare",
            Self::Verify => "verify",
            Self::Remove => "remove",
        }
    }
    fn mutation(self) -> bool {
        matches!(self, Self::Prepare | Self::Remove)
    }
}

pub struct Request<'a> {
    pub config: &'a Path,
    operation: Operation,
    backend: Option<Backend>,
    version: Option<&'a str>,
    dry_run: bool,
}

impl<'a> Request<'a> {
    pub fn parse(args: &'a [String]) -> Result<Self> {
        let usage = "invalid runtime management arguments";
        let operation = match args.first().map(String::as_str) {
            Some("--runtime-status") => Operation::Status,
            Some("--runtime-prepare") => Operation::Prepare,
            Some("--runtime-verify") => Operation::Verify,
            Some("--runtime-remove") => Operation::Remove,
            _ => return Err(usage),
        };
        let mut config = None;
        let mut backend = None;
        let mut version = None;
        let mut dry_run = false;
        let mut options = args[1..].iter().map(String::as_str);
        while let Some(option) = options.next() {
            match option {
                "--dry-run" if operation.mutation() && !dry_run => dry_run = true,
                "--config" if config.is_none() => {
                    config = Some(Path::new(options.next().ok_or(usage)?))
                }
                "--backend" if operation != Operation::Status && backend.is_none() => {
                    let value = options.next().ok_or(usage)?;
                    backend = Some(
                        BACKENDS
                            .into_iter()
                            .find(|b| name(*b) == value)
                            .ok_or(usage)?,
                    );
                }
                "--version" if operation == Operation::Remove && version.is_none() => {
                    version = Some(
                        options
                            .next()
                            .filter(|value| archive::version_valid(value))
                            .ok_or(usage)?,
                    );
                }
                _ => return Err(usage),
            }
        }
        if (operation != Operation::Status && backend.is_none())
            || (operation == Operation::Remove && version.is_none())
        {
            return Err(usage);
        }
        Ok(Self {
            config: config.ok_or(usage)?,
            operation,
            backend,
            version,
            dry_run,
        })
    }
}

struct Installed {
    cache: String,
    version: String,
    verification: Result<()>,
    referenced: bool,
}

fn inventory(
    directory: Option<&Directory>,
    references: &PackageReferences,
    backend: Backend,
) -> Result<Vec<Installed>> {
    let Some(directory) = directory else {
        return Ok(Vec::new());
    };
    let pin = archive::host_pin(backend);
    let current = pin.map(archive::Pin::cache);
    let mut installed = Vec::new();
    for cache in directory.package_entries()? {
        // Resolve current entries from trusted metadata even if files or manifest are damaged.
        if let Some(pin) = pin.filter(|_| current.as_ref() == Some(&cache)) {
            let verification = match directory.cached_package(&cache) {
                Ok(Some(root)) => {
                    archive::verify(pin, &root, Instant::now() + Duration::from_secs(600))
                        .map(|_| ())
                        .map_err(|_| "runtime_integrity_failed")
                }
                Err(super::private::UNSAFE_CACHE_ENTRY) => Err(super::private::UNSAFE_CACHE_ENTRY),
                _ => return Err("runtime_state_unknown"),
            };
            installed.push(Installed {
                referenced: references.contains(&cache),
                cache,
                version: pin.version.clone(),
                verification,
            });
            continue;
        }
        if BACKENDS
            .into_iter()
            .filter(|other| *other != backend)
            .any(|other| archive::host_pin(other).is_some_and(|pin| pin.cache() == cache))
        {
            continue;
        }
        let Ok(Some(root)) = directory.cached_package(&cache) else {
            directory.check()?;
            continue;
        };
        let Some(manifest) = archive::cached_manifest(&cache, &root) else {
            continue;
        };
        if manifest.backend == backend {
            installed.push(Installed {
                referenced: references.contains(&cache),
                cache,
                version: manifest.version,
                verification: Err("runtime_integrity_failed"),
            });
        }
    }
    installed.sort_by(|a, b| {
        a.version
            .cmp(&b.version)
            .then_with(|| a.cache.cmp(&b.cache))
    });
    Ok(installed)
}

fn report_backend(backend: Backend, installed: &[Installed], unknown: bool) -> Value {
    let pin = archive::host_pin(backend);
    let active = pin.and_then(|pin| installed.iter().find(|entry| entry.cache == pin.cache()));
    let damage = active.and_then(|entry| entry.verification.err());
    let state = if unknown {
        "unknown"
    } else if pin.is_none() {
        "unavailable"
    } else if damage.is_some() {
        "failed"
    } else if active.is_some() {
        "verified"
    } else if !installed.is_empty() {
        "installed"
    } else {
        "absent"
    };
    let mut report = json!({
        "backend": name(backend), "available": pin.is_some(), "state": state,
        "qualified": pin.is_some_and(|pin| pin.qualified),
        "installed": installed.iter().map(|entry| json!({
            "version": entry.version,
            "packageDigest": entry.cache.trim_start_matches("runtime-package."),
            "verified": entry.verification.is_ok(), "referenced": entry.referenced,
        })).collect::<Vec<_>>(),
    });
    if let Some(version) = archive::catalog_version(backend) {
        report["catalogVersion"] = json!(version);
    }
    if let Some(entry) = active.filter(|entry| entry.verification.is_ok()) {
        report["active"] = json!(entry.version);
    }
    if unknown {
        report["blocker"] = json!({"code":"runtime_state_unknown","detail":"Runtime state could not be inspected under the executor lock."});
    } else if pin.is_none() {
        report["blocker"] = json!({"code":"runtime_unavailable","detail":archive::unavailable(backend)
            .unwrap_or("No catalog package is available for this platform and architecture.")});
    } else if let Some(code) = damage {
        let detail = if code == super::private::UNSAFE_CACHE_ENTRY {
            "The runtime cache entry has an unsafe type, owner or permissions."
        } else {
            "The installed runtime failed verification."
        };
        report["blocker"] = json!({"code":code,"detail":detail,
            "action":"Reinstall the package once the version is unreferenced."});
    }
    report
}

pub fn execute(request: &Request<'_>, config: &Config) -> Result<(Value, bool)> {
    let path = &config.state_dir;
    if !path.is_absolute()
        || path.file_name().is_none()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("invalid executor state path");
    }
    let mut report = json!({
        "type": "canaveral-runtime-report", "version": 1, "operation": request.operation.name(),
        "dryRun": request.dry_run, "platform": std::env::consts::OS, "arch": std::env::consts::ARCH,
    });
    let backends: Vec<_> = request
        .backend
        .map_or_else(|| BACKENDS.to_vec(), |backend| vec![backend]);
    let inspected = Directory::inspect(path).and_then(|directory| {
        let references = match &directory {
            Some(directory) => load_history(directory)?
                .map(|store| PackageReferences::from_history(&store.entries))
                .unwrap_or_default(),
            None => PackageReferences::default(),
        };
        Ok((directory, references))
    });
    let (directory, references) = match inspected {
        Ok(inspected) => inspected,
        Err(_) => {
            report["backends"] = json!(backends
                .into_iter()
                .map(|backend| report_backend(backend, &[], true))
                .collect::<Vec<_>>());
            if request.operation.mutation() {
                report["plan"] = json!({"downloadBytes":0,"assets":[]});
            }
            if request.operation != Operation::Status {
                report["result"] = json!({"state":"unknown","code":"runtime_state_unknown"});
            }
            return Ok((report, false));
        }
    };

    let mut reports = Vec::new();
    let mut succeeded = true;
    for backend in backends {
        let mut plan = json!({"downloadBytes":0,"assets":[]});
        let mut result = Ok(());
        let mut unknown = false;
        let (mut installed, pin) = match inventory(directory.as_ref(), &references, backend) {
            Ok(items) => (items, archive::host_pin(backend)),
            Err(_) => {
                unknown = true;
                result = Err("runtime_state_unknown");
                (Vec::new(), None)
            }
        };
        if !unknown {
            let current =
                pin.and_then(|pin| installed.iter().find(|entry| entry.cache == pin.cache()));
            match request.operation {
                Operation::Status => {
                    if let Some(entry) = current {
                        result = entry.verification;
                    }
                }
                Operation::Verify => {
                    result = match (pin, current) {
                        (None, _) => Err("runtime_unavailable"),
                        (_, None) => Err("runtime_absent"),
                        (_, Some(entry)) => entry.verification,
                    };
                }
                Operation::Prepare => {
                    result = match (pin, current) {
                        (None, _) => Err("runtime_unavailable"),
                        (_, Some(entry)) if entry.verification.is_ok() => Ok(()),
                        (Some(pin), _)
                            if references.contains(&pin.cache()) && current.is_some() =>
                        {
                            Err("runtime_in_use")
                        }
                        (Some(pin), _) => {
                            plan = json!({"downloadBytes":pin.bytes,"assets":[{"url":pin.url,"sha256":pin.sha256,"bytes":pin.bytes}]});
                            if request.dry_run {
                                Ok(())
                            } else {
                                let owned;
                                let directory = match &directory {
                                    Some(directory) => Ok(directory),
                                    None => {
                                        owned = Directory::open(path);
                                        owned.as_ref().map_err(|error| *error)
                                    }
                                };
                                directory.map_err(|_| "runtime_state_unknown").and_then(
                                    |directory| {
                                        // Opening missing state can race another executor. Recheck from the lock.
                                        let references = load_history(directory)
                                            .map_err(|_| "runtime_state_unknown")?
                                            .map(|store| {
                                                PackageReferences::from_history(&store.entries)
                                            })
                                            .unwrap_or_default();
                                        let staged = archive::stage_with_repair(
                                            pin,
                                            directory,
                                            path,
                                            &references,
                                            false,
                                            true,
                                        )
                                        .map_err(prepare_error);
                                        installed =
                                            inventory(Some(directory), &references, backend)
                                                .map_err(|_| "runtime_state_unknown")?;
                                        staged.map(|_| ())
                                    },
                                )
                            }
                        }
                    };
                }
                Operation::Remove => {
                    let version = request.version.expect("validated remove version");
                    if installed
                        .iter()
                        .any(|entry| entry.version == version && entry.referenced)
                        || pin.is_some_and(|pin| {
                            pin.version == version && references.contains(&pin.cache())
                        })
                    {
                        result = Err("runtime_in_use");
                    } else if let Some(directory) = directory.as_ref().filter(|_| !request.dry_run)
                    {
                        for entry in installed.iter().filter(|entry| entry.version == version) {
                            if directory.delete_package(&entry.cache, &references).is_err() {
                                result = Err("runtime_state_unknown");
                                break;
                            }
                        }
                        match inventory(Some(directory), &references, backend) {
                            Ok(items) => installed = items,
                            Err(_) => {
                                installed.clear();
                                result = Err("runtime_state_unknown");
                            }
                        }
                    }
                }
            }
        }
        unknown |= result == Err("runtime_state_unknown");
        let mut backend_report = report_backend(backend, &installed, unknown);
        if let Err(code) = result {
            succeeded = false;
            if let Some(detail) = prepare_failure_detail(code) {
                if code != "runtime_absent" {
                    backend_report["state"] = json!("failed");
                }
                backend_report["blocker"] = json!({"code":code,"detail":detail});
            }
        }
        reports.push(backend_report);
        if request.operation != Operation::Status {
            if request.operation.mutation() {
                report["plan"] = plan;
            }
            report["result"] = match result {
                Ok(()) => json!({"state":"succeeded"}),
                Err(code) => {
                    json!({"state":if unknown { "unknown" } else { "failed" },"code":code})
                }
            };
        }
    }
    report["backends"] = json!(reports);
    Ok((report, succeeded))
}

fn prepare_error(error: &'static str) -> &'static str {
    match error {
        "runtime archive download failed" | "runtime archive download rejected" => {
            "runtime_download_failed"
        }
        "runtime archive digest mismatch"
        | "runtime archive size mismatch"
        | "runtime archive tree identity mismatch" => "runtime_archive_integrity_failed",
        "runtime_in_use" | "runtime_state_unknown" | super::private::UNSAFE_CACHE_ENTRY => error,
        _ => "runtime_prepare_failed",
    }
}

fn prepare_failure_detail(code: &str) -> Option<&'static str> {
    match code {
        "runtime_download_failed" => Some("The pinned runtime archive could not be downloaded."),
        "runtime_archive_integrity_failed" => {
            Some("The downloaded runtime archive failed verification.")
        }
        "runtime_prepare_failed" => Some("The runtime archive could not be prepared and verified."),
        "runtime_absent" => Some("Install the catalog runtime version before verifying it."),
        _ => None,
    }
}
