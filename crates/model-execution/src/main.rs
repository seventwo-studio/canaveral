#[cfg(unix)]
fn main() {
    let result = (|| {
        let mut args = std::env::args_os().skip(1);
        let path = args.next().ok_or("private runner configuration required")?;
        if args.next().is_some() {
            return Err("expected one configuration file");
        }
        let bytes = std::fs::read(path).map_err(|_| "configuration unavailable")?;
        let config = serde_json::from_slice(&bytes).map_err(|_| "invalid configuration")?;
        canaveral_model_execution::controller::run_once(config)
    })();
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
#[cfg(not(unix))]
fn main() {
    eprintln!("owned Ollama execution is unsupported on this platform");
    std::process::exit(1);
}
