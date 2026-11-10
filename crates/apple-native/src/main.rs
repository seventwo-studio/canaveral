#[cfg(unix)]
#[path = "../../../coordination/src/providers/apple-native.rs"]
mod native;

#[cfg(unix)]
fn main() {
    native::main();
}

#[cfg(not(unix))]
fn main() {
    eprintln!("Apple runtime ownership requires a Unix host.");
    std::process::exit(1);
}
