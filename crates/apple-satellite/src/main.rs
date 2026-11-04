#[cfg(unix)]
fn run() -> Result<(), &'static str> {
    use canaveral_apple_satellite::{Authenticated, Config, Satellite};
    use canaveral_runner_client::{Identity, Transport};
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 || args[1] != "run-once" {
        return Err("usage: canaveral-apple-satellite run-once ABSOLUTE_CONFIG_JSON");
    }
    let config: Config = canaveral_apple_satellite::read_config(std::path::Path::new(&args[2]))?;
    // Artifact, signature and journal preflight completes before any controller contact.
    let mut satellite = Satellite::open(config.clone())?;
    let ca = config
        .ca
        .as_ref()
        .map(|path| canaveral_apple_satellite::read_ca(path))
        .transpose()
        .map_err(|_| "invalid CA trust file")?;
    let transport =
        Transport::new(&config.origin, ca.as_deref()).map_err(|_| "invalid HTTPS transport")?;
    let mut identity = Identity::open(&config.identity, &config.origin, &config.binding)
        .map_err(|_| "identity binding rejected")?;
    identity
        .authenticate(&transport)
        .map_err(|_| "current identity authentication failed")?;
    satellite.run_once(&mut Authenticated {
        identity: &identity,
        transport: &transport,
    })
}
#[cfg(not(unix))]
fn run() -> Result<(), &'static str> {
    Err("canaveral-apple-satellite supports only macOS hosts")
}
fn main() {
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(1)
    }
}
