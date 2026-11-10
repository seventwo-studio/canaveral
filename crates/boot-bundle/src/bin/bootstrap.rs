fn main() {
    #[cfg(unix)]
    if let Err(e) = canaveral_boot_bundle::bootstrap::run() {
        eprintln!("bootstrap refused: {e}");
        std::process::exit(1)
    }
    #[cfg(not(unix))]
    {
        eprintln!("bootstrap refused: bootstrap requires Linux PID1");
        std::process::exit(1)
    }
}
