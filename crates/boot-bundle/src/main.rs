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
        || a[0] != "assemble"
        || a[1] != "--recipe"
        || a[3] != "--inputs"
        || a[5] != "--output"
    {
        return Err(
            "usage: canaveral-boot-bundle assemble --recipe FILE --inputs DIR --output NEW_DIR"
                .into(),
        );
    }
    let bytes = canaveral_boot_bundle::read_recipe(Path::new(&a[2]))?;
    canaveral_boot_bundle::assemble(&bytes, Path::new(&a[4]), Path::new(&a[6]))?;
    Ok(())
}
#[cfg(not(unix))]
fn run() -> canaveral_guest_protocol::Result<()> {
    Err("boot bundle authoring requires a Unix host".into())
}
