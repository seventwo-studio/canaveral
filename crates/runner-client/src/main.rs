use canaveral_runner_client::{bounded, Approval, Binding, Error, Identity, Result, Transport};
use std::path::Path;
fn run() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    if !(args.len() == 4 || args.len() == 5)
        || !matches!(args[1].as_str(), "prepare" | "consume" | "authenticate")
    {
        return Err(Error("usage: canaveral-runner-client prepare|consume|authenticate ABSOLUTE_STATE_DIR HTTPS_ORIGIN [CA_PEM_FILE]; JSON on stdin (approval for prepare, expected binding otherwise)"));
    }
    let bytes = bounded(std::io::stdin().lock())?;
    let path = Path::new(&args[2]);
    if args[1] == "prepare" {
        let approval: Approval =
            serde_json::from_slice(&bytes).map_err(|_| Error("invalid approval"))?;
        Identity::prepare(path, &args[3], approval)?;
        println!("identity durably prepared; no request sent");
    } else {
        let binding: Binding =
            serde_json::from_slice(&bytes).map_err(|_| Error("invalid expected binding"))?;
        let ca = args
            .get(4)
            .map(|p| {
                std::fs::File::open(p)
                    .map_err(|_| Error("cannot read trusted CA"))
                    .and_then(bounded)
            })
            .transpose()?;
        let t = Transport::new(&args[3], ca.as_deref())?;
        let mut id = Identity::open(path, &args[3], &binding)?;
        if args[1] == "consume" {
            id.consume(&t)?;
        } else {
            id.authenticate(&t)?;
        }
        println!("current binding authenticated; receipt durable (identity only)");
    }
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
