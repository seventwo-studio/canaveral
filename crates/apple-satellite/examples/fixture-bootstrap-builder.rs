//! Fixture-only stand-in for an operator-installed `mkfs.erofs`. It writes a SIMULATED EROFS
//! image: the superblock magic at byte 1024, a "not mountable" label and the staged
//! launch.json bytes. It is not a filesystem and proves nothing about mountability.
//! It accepts only the satellite's fixed argv:
//! `--quiet --all-root -b4096 -T 0 -U UUID DESTINATION SOURCE`, with SOURCE holding only launch.json.
pub const LABEL: &[u8] = b"CANAVERAL-SIMULATED-EROFS-NOT-MOUNTABLE\n";
#[cfg(unix)]
fn run() -> Result<(), String> {
    use std::{io::Write, os::unix::fs::OpenOptionsExt, path::Path};
    let args: Vec<String> = std::env::args().skip(1).collect();
    let fixed = ["--quiet", "--all-root", "-b4096", "-T", "0", "-U"];
    if args.len() != 9 || args[..6] != fixed || uuid::Uuid::parse_str(&args[6]).is_err() {
        return Err("unexpected builder argv".into());
    }
    if std::env::vars_os().next().is_some() {
        return Err("builder environment was not cleared".into());
    }
    let source = Path::new(&args[8]);
    let entries: Vec<_> = std::fs::read_dir(source)
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    if entries.len() != 1 || entries[0].file_name() != "launch.json" {
        return Err("unexpected staging content".into());
    }
    let launch = std::fs::read(source.join("launch.json")).map_err(|e| e.to_string())?;
    let mut image = vec![0u8; 1024];
    image.extend([0xe2, 0xe1, 0xf5, 0xe0]);
    image.extend(LABEL);
    image.extend(launch);
    let mut out = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&args[7])
        .map_err(|e| e.to_string())?;
    out.write_all(&image).map_err(|e| e.to_string())?;
    out.sync_all().map_err(|e| e.to_string())
}
#[cfg(not(unix))]
fn run() -> Result<(), String> {
    Err("fixture builder requires a Unix host".into())
}
fn main() {
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
