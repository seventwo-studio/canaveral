//! Fixture driver for the narrow authenticated lease API; no credential extraction.
use canaveral_runner_client::{bounded, Binding, Identity, LeaseRoute, Transport};
fn main() {
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        let args: Vec<_> = std::env::args().collect();
        let input: serde_json::Value = serde_json::from_slice(&bounded(std::io::stdin().lock())?)?;
        let binding: Binding = serde_json::from_value(input["binding"].clone())?;
        let ca = std::fs::read(&args[3])?;
        let t = Transport::new(&args[2], Some(&ca))?;
        let mut id = Identity::open(std::path::Path::new(&args[1]), &args[2], &binding)?;
        id.authenticate(&t)?;
        let route = match args[4].as_str() {
            "claim" => LeaseRoute::Claim,
            "assignments" => LeaseRoute::Assignments,
            "report" => LeaseRoute::Report,
            _ => return Err("invalid route".into()),
        };
        let response = id.linux_lease_request(&t, route, input["body"].clone())?;
        println!("{response}");
        Ok(())
    })();
    if result.is_err() {
        eprintln!("lease fixture request rejected or uncertain");
        std::process::exit(1);
    }
}
