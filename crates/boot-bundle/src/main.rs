#[cfg(unix)]
use std::path::Path;
fn main() {
    if let Err(e) = run() {
        eprintln!("boot bundle: {e}");
        std::process::exit(1)
    }
}
#[cfg(unix)]
fn run() -> canaveral_guest_protocol::Result<()> {
    let a: Vec<_> = std::env::args().skip(1).collect();
    if a.len() != 7
        || a[1] != "--recipe"
        || a[3] != "--inputs"
        || !matches!((a[0].as_str(), a[5].as_str()),
            ("assemble", "--output") | ("verify-inputs", "--evidence"))
    {
        return Err(usage().into());
    }
    let bytes = canaveral_boot_bundle::read_recipe(Path::new(&a[2]))?;
    match (a[0].as_str(), a[5].as_str()) {
        ("assemble", "--output") => {
            canaveral_boot_bundle::assemble(&bytes, Path::new(&a[4]), Path::new(&a[6]))?;
        }
        ("verify-inputs", "--evidence") => {
            let evidence = canaveral_boot_bundle::read_recipe(Path::new(&a[6]))?;
            let report = canaveral_boot_bundle::verify_inputs(&bytes, &evidence, Path::new(&a[4]))?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        _ => return Err(usage().into()),
    }
    Ok(())
}
#[cfg(unix)]
fn usage() -> &'static str {
    "usage: canaveral-boot-bundle assemble --recipe FILE --inputs DIR --output NEW_DIR\n       canaveral-boot-bundle verify-inputs --recipe FILE --inputs DIR --evidence FILE"
}
#[cfg(not(unix))]
fn run() -> canaveral_guest_protocol::Result<()> {
    Err("boot bundle authoring requires a Unix host".into())
}
