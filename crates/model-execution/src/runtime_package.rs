//! Canaveral-managed, pinned runtime provisioning. Sources are trusted release
//! catalog metadata or distribution-bundled assets, never consumer input.
use crate::{private, Config, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    os::{fd::AsRawFd, unix::fs::MetadataExt},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
pub(super) const FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub(super) const PACKAGE_BYTES: u64 = 8 * 1024 * 1024 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimePackage {
    pub os: String,
    pub arch: String,
    #[serde(default)]
    pub root: PathBuf,
    #[serde(default)]
    pub base_url: Option<String>,
    pub entrypoint: String,
    pub files: BTreeMap<String, String>,
    #[serde(default)]
    pub executables: Vec<String>,
}
pub(super) fn invalid() -> &'static str {
    "invalid pinned runtime package"
}
pub(super) fn hash_valid(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(super) fn parts(path: &str) -> Result<Vec<&str>> {
    let values: Vec<_> = path.split('/').collect();
    if path.len() > 1024
        || values.len() > 32
        || values.iter().any(|v| {
            v.is_empty()
                || *v == "."
                || *v == ".."
                || v.len() > 255
                || v.bytes()
                    .any(|b| b == 0 || b == b'\\' || b.is_ascii_control())
        })
    {
        return Err(invalid());
    }
    Ok(values)
}
pub(super) fn https_url(value: &str, test_loopback: bool) -> Result<reqwest::Url> {
    if value.len() > 4096 {
        return Err(invalid());
    }
    let url = reqwest::Url::parse(value).map_err(|_| invalid())?;
    let loopback = cfg!(test)
        && test_loopback
        && url.scheme() == "http"
        && url
            .host_str()
            .and_then(|v| v.parse::<std::net::IpAddr>().ok())
            .is_some_and(|ip| ip.is_loopback());
    let authority = value
        .split_once("://")
        .map(|(_, rest)| rest.split('/').next().unwrap_or(""))
        .unwrap_or("");
    if (url.scheme() != "https" && !loopback)
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || authority.contains('@')
        || url.query().is_some()
        || url.fragment().is_some()
        || value.bytes().any(|b| b.is_ascii_control() || b == b'\\')
    {
        return Err("trusted HTTPS runtime release origin required");
    }
    Ok(url)
}
fn base_url(value: &str, test_loopback: bool) -> Result<reqwest::Url> {
    let url = https_url(value, test_loopback)?;
    if !url.path().ends_with('/') {
        return Err(invalid());
    }
    Ok(url)
}
pub(super) fn validate_package(package: &RuntimePackage, test_loopback: bool) -> Result<()> {
    if !matches!(package.os.as_str(), "linux" | "macos")
        || !matches!(package.arch.as_str(), "x86_64" | "aarch64")
        || package.files.is_empty()
        || package.files.len() > 4096
        || package.executables.len() > package.files.len()
    {
        return Err(invalid());
    }
    match &package.base_url {
        Some(url) if package.root.as_os_str().is_empty() => {
            base_url(url, test_loopback)?;
        }
        None if package.root.is_absolute() && package.root.as_os_str().len() <= 4096 => {}
        _ => return Err("one managed runtime source required"),
    }
    parts(&package.entrypoint)?;
    if !package.files.contains_key(&package.entrypoint) {
        return Err(invalid());
    }
    let mut executable_set = BTreeSet::new();
    for path in &package.executables {
        if !package.files.contains_key(path) || !executable_set.insert(path) {
            return Err(invalid());
        }
    }
    let mut path_bytes = 0usize;
    for (path, hash) in &package.files {
        let components = parts(path)?;
        if !hash_valid(hash) {
            return Err(invalid());
        }
        path_bytes += path.len();
        if path_bytes > 1024 * 1024 {
            return Err(invalid());
        }
        let mut prefix = String::new();
        for part in components.iter().take(components.len() - 1) {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(part);
            if package.files.contains_key(&prefix) {
                return Err(invalid());
            }
        }
    }
    Ok(())
}
pub(super) fn validate(config: &Config) -> Result<()> {
    if config.runtime_packages.is_empty() {
        if config.executable.as_os_str().is_empty()
            && config.executable_sha256.is_empty()
            && crate::runtime_archive::host_pin(config.backend).is_some()
        {
            return Ok(());
        }
        if !config.executable.is_absolute() || !hash_valid(&config.executable_sha256) {
            return Err("absolute operator paths and pinned runtime hash required");
        }
        return Ok(());
    }
    if !config.executable.as_os_str().is_empty()
        || !config.executable_sha256.is_empty()
        || config.runtime_packages.len() > 16
    {
        return Err(invalid());
    }
    for package in &config.runtime_packages {
        validate_package(package, false)?;
    }
    Ok(())
}
pub(super) fn select(packages: &[RuntimePackage]) -> Result<Option<&RuntimePackage>> {
    if packages.is_empty() {
        return Ok(None);
    }
    let mut matching = packages
        .iter()
        .filter(|p| p.os == std::env::consts::OS && p.arch == std::env::consts::ARCH);
    let package = matching.next().ok_or("no runtime package for this host")?;
    if matching.next().is_some() {
        return Err("ambiguous runtime packages for this host");
    }
    Ok(Some(package))
}
fn trusted(file: &File, directory: bool) -> Result<()> {
    let m = file.metadata().map_err(|_| invalid())?;
    if !(m.uid() == 0 || m.uid() == unsafe { libc::geteuid() })
        || m.mode() & 0o6022 != 0
        || if directory {
            !m.is_dir()
        } else {
            !m.is_file() || m.nlink() != 1
        }
    {
        return Err("unsafe runtime package asset");
    }
    Ok(())
}
pub(super) fn directory(parent: &File, value: &str, create: bool) -> Result<File> {
    let n = private::name(value.as_ref())?;
    if create {
        let rc = unsafe { libc::mkdirat(parent.as_raw_fd(), n.as_ptr(), 0o700) };
        if rc != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST) {
            return Err(invalid());
        }
        parent.sync_all().map_err(|_| invalid())?;
    }
    let dir = private::openat(parent, &n, libc::O_RDONLY | libc::O_DIRECTORY)?;
    trusted(&dir, true)?;
    Ok(dir)
}
pub(super) fn executable(package: &RuntimePackage, path: &str) -> bool {
    path == package.entrypoint || package.executables.iter().any(|v| v == path)
}
fn native_entrypoint(os: &str, magic: [u8; 4]) -> bool {
    match os {
        "linux" => magic == *b"\x7fELF",
        "macos" => matches!(
            magic,
            [0xfe, 0xed, 0xfa, 0xce]
                | [0xfe, 0xed, 0xfa, 0xcf]
                | [0xce, 0xfa, 0xed, 0xfe]
                | [0xcf, 0xfa, 0xed, 0xfe]
                | [0xca, 0xfe, 0xba, 0xbe]
                | [0xca, 0xfe, 0xba, 0xbf]
                | [0xbe, 0xba, 0xfe, 0xca]
                | [0xbf, 0xba, 0xfe, 0xca]
        ),
        _ => false,
    }
}
pub(super) fn identity(package: &RuntimePackage) -> Result<String> {
    // Sources are excluded: a pinned artifact has the same identity when bundled
    // or fetched. Permissions and layout are part of artifact identity.
    let executables: BTreeSet<_> = package
        .executables
        .iter()
        .map(String::as_str)
        .chain(std::iter::once(package.entrypoint.as_str()))
        .collect();
    let bytes = serde_json::to_vec(&serde_json::json!({"version":1,"os":package.os,"arch":package.arch,"entrypoint":package.entrypoint,"files":package.files,"executables":executables})).map_err(|_| invalid())?;
    Ok(format!("runtime-package.{:x}", Sha256::digest(bytes)))
}
fn copy_hashed(
    input: &mut dyn Read,
    mut output: Option<&mut File>,
    expected: &str,
    total: &mut u64,
    deadline: Instant,
) -> Result<()> {
    let mut hash = Sha256::new();
    let mut copied = 0u64;
    let mut buffer = [0u8; 65536];
    loop {
        if Instant::now() >= deadline {
            return Err("runtime installation deadline");
        }
        let n = input
            .read(&mut buffer)
            .map_err(|_| "runtime package asset unavailable")?;
        if n == 0 {
            break;
        }
        copied += n as u64;
        *total += n as u64;
        if copied > FILE_BYTES || *total > PACKAGE_BYTES {
            return Err("runtime package byte bound exceeded");
        }
        hash.update(&buffer[..n]);
        if let Some(output) = &mut output {
            output.write_all(&buffer[..n]).map_err(|_| invalid())?;
        }
    }
    if format!("{:x}", hash.finalize()) != expected {
        return Err("runtime package asset identity mismatch");
    }
    Ok(())
}
pub(super) fn verify_cache(
    package: &RuntimePackage,
    root: &File,
    deadline: Instant,
    archive_manifest: Option<&[u8]>,
) -> Result<()> {
    let mut expected = BTreeMap::new();
    for path in package.files.keys() {
        expected.insert(path.clone(), false);
        let components = parts(path)?;
        for i in 1..components.len() {
            expected.insert(components[..i].join("/"), true);
        }
    }
    fn visit(
        package: &RuntimePackage,
        dir: &File,
        prefix: &str,
        expected: &mut BTreeMap<String, bool>,
        total: &mut u64,
        deadline: Instant,
    ) -> Result<()> {
        trusted(dir, true)?;
        let meta = dir.metadata().map_err(|_| invalid())?;
        if meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o7777 != 0o700 {
            return Err("unsafe installed runtime directory");
        }
        for entry in private::entries(dir)? {
            let path = if prefix.is_empty() {
                entry.clone()
            } else {
                format!("{prefix}/{entry}")
            };
            match expected
                .remove(&path)
                .ok_or("unlisted installed runtime asset")?
            {
                true => visit(
                    package,
                    &directory(dir, &entry, false)?,
                    &path,
                    expected,
                    total,
                    deadline,
                )?,
                false => {
                    let mut file =
                        private::openat(dir, &private::name(entry.as_ref())?, libc::O_RDONLY)?;
                    trusted(&file, false)?;
                    let m = file.metadata().map_err(|_| invalid())?;
                    let mode = if executable(package, &path) {
                        0o500
                    } else {
                        0o400
                    };
                    if m.uid() != unsafe { libc::geteuid() }
                        || m.mode() & 0o7777 != mode
                        || m.len() > FILE_BYTES
                    {
                        return Err("unsafe installed runtime asset");
                    }
                    if path == package.entrypoint {
                        let mut magic = [0; 4];
                        file.read_exact(&mut magic)
                            .map_err(|_| "native runtime entrypoint required")?;
                        if !native_entrypoint(&package.os, magic) {
                            return Err("native runtime entrypoint required");
                        }
                        file.seek(SeekFrom::Start(0)).map_err(|_| invalid())?;
                    }
                    copy_hashed(&mut file, None, &package.files[&path], total, deadline)?;
                    trusted(&file, false)?;
                }
            }
        }
        Ok(())
    }
    let content;
    let package = if let Some(bytes) = archive_manifest {
        expected.insert(crate::runtime_archive::MANIFEST.to_owned(), false);
        content = {
            let mut content = package.clone();
            content.files.insert(
                crate::runtime_archive::MANIFEST.to_owned(),
                format!("{:x}", Sha256::digest(bytes)),
            );
            content
        };
        &content
    } else {
        package
    };
    visit(package, root, "", &mut expected, &mut 0, deadline)?;
    if !expected.is_empty() {
        return Err("incomplete installed runtime package");
    }
    Ok(())
}
pub(super) fn stage(
    package: &RuntimePackage,
    state: &private::Directory,
    state_path: &Path,
    references: &crate::PackageReferences,
) -> Result<PathBuf> {
    stage_inner(package, state, state_path, false, references)
}
fn stage_inner(
    package: &RuntimePackage,
    state: &private::Directory,
    state_path: &Path,
    test_loopback: bool,
    references: &crate::PackageReferences,
) -> Result<PathBuf> {
    validate_package(package, test_loopback)?;
    state.check()?;
    let cache = identity(package)?;
    let installed_path = state_path.join(&cache).join(&package.entrypoint);
    let deadline = Instant::now() + Duration::from_secs(600);
    if let Some(installed) = state.cached_package(&cache)? {
        // Tampering is an error, never an instruction to overwrite evidence.
        verify_cache(package, &installed, deadline, None)?;
        state.check()?;
        state.prune_packages(&cache, references, |_, root| {
            Ok(crate::runtime_archive::manifest_bytes(root)?.is_none())
        })?;
        return Ok(installed_path);
    }
    let source = if package.base_url.is_none() {
        let source = private::walk(&package.root)?;
        trusted(&source, true)?;
        Some(source)
    } else {
        None
    };
    let client = if package.base_url.is_some() {
        Some(download_client(reqwest::redirect::Policy::none())?)
    } else {
        None
    };
    let output = state.package_workspace()?;
    let mut total = 0;
    for (path, expected) in &package.files {
        state.check()?;
        let components = parts(path)?;
        let mut dst = output.try_clone().map_err(|_| invalid())?;
        for component in components.iter().take(components.len() - 1) {
            dst = directory(&dst, component, true)?;
        }
        let n = private::name(components.last().ok_or_else(invalid)?.as_ref())?;
        let mut target = private::openat(&dst, &n, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL)?;
        if let Some(source) = &source {
            let mut src = source.try_clone().map_err(|_| invalid())?;
            for component in components.iter().take(components.len() - 1) {
                src = directory(&src, component, false)?;
            }
            let mut input = private::openat(&src, &n, libc::O_RDONLY)?;
            trusted(&input, false)?;
            let meta = input.metadata().map_err(|_| invalid())?;
            if meta.len() > FILE_BYTES || (executable(package, path) && meta.mode() & 0o111 == 0) {
                return Err("runtime package asset exceeds bounds or is not executable");
            }
            copy_hashed(
                &mut input,
                Some(&mut target),
                expected,
                &mut total,
                deadline,
            )?;
            trusted(&input, false)?;
        } else {
            let mut url = base_url(
                package.base_url.as_deref().ok_or_else(invalid)?,
                test_loopback,
            )?;
            {
                let mut segments = url.path_segments_mut().map_err(|_| invalid())?;
                segments.pop_if_empty();
                for component in &components {
                    segments.push(component);
                }
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("runtime installation deadline");
            }
            let mut response = client
                .as_ref()
                .ok_or_else(invalid)?
                .get(url)
                .timeout(remaining.min(Duration::from_secs(120)))
                .send()
                .map_err(|_| "runtime package download failed")?;
            if !response.status().is_success()
                || response
                    .content_length()
                    .is_some_and(|n| n > FILE_BYTES || n > PACKAGE_BYTES.saturating_sub(total))
            {
                return Err("runtime package download rejected");
            }
            copy_hashed(
                &mut response,
                Some(&mut target),
                expected,
                &mut total,
                deadline,
            )?;
        }
        let mode = if executable(package, path) {
            0o500
        } else {
            0o400
        };
        if unsafe { libc::fchmod(target.as_raw_fd(), mode) } != 0 {
            return Err(invalid());
        }
        target.sync_all().map_err(|_| invalid())?;
        dst.sync_all().map_err(|_| invalid())?;
    }
    publish(package, state, &output, &cache, deadline, None)?;
    state.prune_packages(&cache, references, |_, root| {
        Ok(crate::runtime_archive::manifest_bytes(root)?.is_none())
    })?;
    Ok(installed_path)
}

pub(super) fn download_client(
    policy: reqwest::redirect::Policy,
) -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(policy)
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|_| "runtime provisioner unavailable")
}

pub(super) fn publish(
    package: &RuntimePackage,
    state: &private::Directory,
    output: &File,
    cache: &str,
    deadline: Instant,
    archive_manifest: Option<&[u8]>,
) -> Result<()> {
    output.sync_all().map_err(|_| invalid())?;
    verify_cache(package, output, deadline, archive_manifest)?;
    state.publish_package(cache)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "macos")]
    const RUNTIME_BYTES: &[u8] = b"\xcf\xfa\xed\xfenative runtime fixture";
    #[cfg(not(target_os = "macos"))]
    const RUNTIME_BYTES: &[u8] = b"\x7fELFnative runtime fixture";
    use std::{
        fs,
        net::TcpListener,
        os::unix::fs::{symlink, PermissionsExt},
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
    };
    fn package(root: PathBuf) -> RuntimePackage {
        RuntimePackage {
            os: std::env::consts::OS.into(),
            arch: std::env::consts::ARCH.into(),
            root,
            base_url: None,
            entrypoint: "bin/runtime".into(),
            files: BTreeMap::from([(
                "bin/runtime".into(),
                format!("{:x}", Sha256::digest(RUNTIME_BYTES)),
            )]),
            executables: vec![],
        }
    }
    fn root() -> tempfile::TempDir {
        tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap()
    }
    fn serve(
        bodies: Vec<(u16, Vec<u8>)>,
    ) -> (String, Arc<AtomicUsize>, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/release/", listener.local_addr().unwrap());
        let count = Arc::new(AtomicUsize::new(0));
        let observed = count.clone();
        let task = std::thread::spawn(move || {
            for (status, body) in bodies {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut request = vec![];
                let mut byte = [0];
                while !request.ends_with(b"\r\n\r\n") {
                    stream.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                }
                assert!(String::from_utf8_lossy(&request).starts_with("GET /release/"));
                observed.fetch_add(1, Ordering::SeqCst);
                write!(stream, "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nLocation: http://127.0.0.1:1/forbidden\r\nConnection: close\r\n\r\n", body.len()).unwrap();
                stream.write_all(&body).unwrap();
            }
        });
        (url, count, task)
    }
    #[test]
    fn host_selection_fails_without_one_exact_match() {
        let p = package(PathBuf::from("/private/runtime"));
        assert!(select(std::slice::from_ref(&p)).unwrap().is_some());
        assert!(select(&[p.clone(), p.clone()]).is_err());
        let mut foreign = p;
        foreign.os = "unsupported".into();
        assert!(select(&[foreign]).is_err());
        assert!(select(&[]).unwrap().is_none());
    }
    #[test]
    fn entrypoint_magic_matches_declared_os_without_accepting_scripts() {
        assert!(native_entrypoint("linux", *b"\x7fELF"));
        assert!(!native_entrypoint("macos", *b"\x7fELF"));
        for magic in [
            [0xfe, 0xed, 0xfa, 0xce],
            [0xfe, 0xed, 0xfa, 0xcf],
            [0xce, 0xfa, 0xed, 0xfe],
            [0xcf, 0xfa, 0xed, 0xfe],
            [0xca, 0xfe, 0xba, 0xbe],
            [0xca, 0xfe, 0xba, 0xbf],
            [0xbe, 0xba, 0xfe, 0xca],
            [0xbf, 0xba, 0xfe, 0xca],
        ] {
            assert!(native_entrypoint("macos", magic));
            assert!(!native_entrypoint("linux", magic));
        }
        assert!(!native_entrypoint("linux", *b"#!/u"));
        assert!(!native_entrypoint("macos", *b"#!/u"));
    }
    #[test]
    fn correctly_pinned_script_entrypoints_rejected_in_download_and_cache() {
        let script = b"#!/usr/bin/env python3\nprint('ambient interpreter')\n";
        let temp = root();
        let state_path = temp.path().join("state");
        let state = private::Directory::open(&state_path).unwrap();
        let (url, _, task) = serve(vec![(200, script.to_vec())]);
        let mut p = package(PathBuf::new());
        p.base_url = Some(url);
        p.files.insert(
            p.entrypoint.clone(),
            format!("{:x}", Sha256::digest(script)),
        );
        assert_eq!(
            stage_inner(&p, &state, &state_path, true, &Default::default()),
            Err("native runtime entrypoint required")
        );
        task.join().unwrap();
        let cached = state_path.join(identity(&p).unwrap());
        assert!(!cached.exists());
        fs::create_dir_all(cached.join("bin")).unwrap();
        fs::set_permissions(&cached, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(cached.join("bin"), fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(cached.join(&p.entrypoint), script).unwrap();
        fs::set_permissions(
            cached.join(&p.entrypoint),
            fs::Permissions::from_mode(0o500),
        )
        .unwrap();
        assert_eq!(
            stage_inner(&p, &state, &state_path, true, &Default::default()),
            Err("native runtime entrypoint required")
        );
        assert!(!state_path.join("claim.json").exists());
    }
    #[test]
    fn package_paths_reject_traversal_and_unbounded_names() {
        for path in [
            "",
            "/bin/runtime",
            "../runtime",
            "bin/./runtime",
            "bin//runtime",
            "bin/../runtime",
            "bin\\runtime",
            "bad\0name",
        ] {
            assert!(parts(path).is_err(), "{path:?}");
        }
        assert!(parts(&"a/".repeat(40)).is_err());
        assert!(parts(&"x".repeat(256)).is_err());
        assert!(parts("bin/runtime").is_ok());
    }
    #[test]
    fn production_catalog_urls_reject_credentials_and_plain_http() {
        for value in [
            "http://127.0.0.1:1/release/",
            "https://user:secret@example.test/release/",
            "https://@example.test/release/",
            "https://example.test/release/?token=secret",
            "https://example.test/release/#fragment",
            "https://example.test/release",
        ] {
            assert!(base_url(value, false).is_err(), "{value}");
        }
        assert!(base_url("https://releases.example.test/runtime/v1/", false).is_ok());
        assert!(base_url("http://localhost/release/", true).is_err());
    }
    #[test]
    fn automatic_download_installs_helpers_once_and_revalidates_cache() {
        let temp = root();
        let state_path = temp.path().join("state");
        let state = private::Directory::open(&state_path).unwrap();
        let (url, count, task) = serve(vec![
            (200, b"helper fixture".to_vec()),
            (200, RUNTIME_BYTES.to_vec()),
        ]);
        let mut p = package(PathBuf::new());
        p.base_url = Some(url);
        p.files.insert(
            "bin/helper".into(),
            format!("{:x}", Sha256::digest(b"helper fixture")),
        );
        p.executables.push("bin/helper".into());
        let installed = stage_inner(&p, &state, &state_path, true, &Default::default()).unwrap();
        task.join().unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 2);
        assert_eq!(fs::read(&installed).unwrap(), RUNTIME_BYTES);
        assert_eq!(
            fs::metadata(installed.with_file_name("helper"))
                .unwrap()
                .mode()
                & 0o777,
            0o500
        );
        assert_eq!(
            stage_inner(&p, &state, &state_path, true, &Default::default()).unwrap(),
            installed
        );
        assert_eq!(count.load(Ordering::SeqCst), 2); // Listener is closed: cached work needs no network.
        assert!(!state_path.join("claim.json").exists());
        fs::set_permissions(&installed, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(&installed, b"tampered").unwrap();
        fs::set_permissions(&installed, fs::Permissions::from_mode(0o500)).unwrap();
        assert!(stage_inner(&p, &state, &state_path, true, &Default::default()).is_err());
        assert_eq!(fs::read(&installed).unwrap(), b"tampered"); // Preserve evidence; no repair download.
    }
    #[test]
    fn failed_download_and_redirect_never_publish_or_create_claim() {
        for (status, body) in [
            (302, RUNTIME_BYTES.to_vec()),
            (200, b"tampered".to_vec()),
            (500, vec![]),
        ] {
            let temp = root();
            let path = temp.path().join("state");
            let state = private::Directory::open(&path).unwrap();
            let (url, count, task) = serve(vec![(status, body)]);
            let mut p = package(PathBuf::new());
            p.base_url = Some(url);
            assert!(stage_inner(&p, &state, &path, true, &Default::default()).is_err());
            task.join().unwrap();
            assert_eq!(count.load(Ordering::SeqCst), 1);
            assert!(!path.join(identity(&p).unwrap()).exists());
            assert!(!path.join("claim.json").exists());
        }
    }
    #[test]
    fn bundled_cache_rejects_extra_assets_links_and_survives_source_removal() {
        for mode in ["extra", "symlink", "hardlink"] {
            let temp = root();
            let source = temp.path().join("bundled");
            fs::create_dir_all(source.join("bin")).unwrap();
            fs::write(source.join("bin/runtime"), RUNTIME_BYTES).unwrap();
            fs::set_permissions(
                source.join("bin/runtime"),
                fs::Permissions::from_mode(0o500),
            )
            .unwrap();
            let p = package(source.clone());
            let path = temp.path().join("state");
            let state = private::Directory::open(&path).unwrap();
            let installed = stage(&p, &state, &path, &Default::default()).unwrap();
            fs::remove_dir_all(&source).unwrap();
            assert_eq!(
                stage(&p, &state, &path, &Default::default()).unwrap(),
                installed
            );
            match mode {
                "extra" => fs::write(installed.with_file_name("extra"), b"stale").unwrap(),
                "symlink" => {
                    fs::remove_file(&installed).unwrap();
                    symlink("/does-not-exist", &installed).unwrap();
                }
                "hardlink" => fs::hard_link(&installed, temp.path().join("hardlink")).unwrap(),
                _ => unreachable!(),
            }
            assert!(
                stage(&p, &state, &path, &Default::default()).is_err(),
                "{mode}"
            );
        }
    }
    #[test]
    fn changed_package_publishes_then_prunes_old_version_and_recovers_candidates() {
        let temp = root();
        let source = temp.path().join("bundled");
        fs::create_dir_all(source.join("bin")).unwrap();
        fs::write(source.join("bin/runtime"), RUNTIME_BYTES).unwrap();
        fs::set_permissions(
            source.join("bin/runtime"),
            fs::Permissions::from_mode(0o500),
        )
        .unwrap();
        let mut p = package(source.clone());
        let path = temp.path().join("state");
        let state = private::Directory::open(&path).unwrap();
        let old = stage(&p, &state, &path, &Default::default()).unwrap();
        let next = path.join("runtime-package.next");
        fs::create_dir(&next).unwrap();
        fs::write(next.join("unpublished"), b"partial").unwrap();
        p.files.insert(
            "data/new".into(),
            format!("{:x}", Sha256::digest(b"new version")),
        );
        assert!(stage(&p, &state, &path, &Default::default()).is_err()); // Missing new source: old version remains usable.
        assert!(old.exists());
        fs::create_dir(source.join("data")).unwrap();
        fs::write(source.join("data/new"), b"new version").unwrap();
        let old_cache = old
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .trim_start_matches("runtime-package.");
        let referenced = crate::PackageReferences {
            all: false,
            digests: [old_cache.to_owned()].into_iter().collect(),
        };
        let installed = stage(&p, &state, &path, &referenced).unwrap();
        assert!(old.exists());
        assert_eq!(
            stage(&p, &state, &path, &Default::default()).unwrap(),
            installed
        );
        assert!(!old.exists());
        assert!(installed.exists());
        assert!(!next.exists());
        assert!(!installed
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("unpublished")
            .exists());
    }
}
