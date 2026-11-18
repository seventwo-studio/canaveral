#[cfg(unix)]
mod preview;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    #[cfg(unix)]
    if args.first().is_some_and(|arg| arg == "--preview-service") {
        match preview::run(&args[1..]) {
            Ok(code) => std::process::exit(code),
            Err(error) => {
                eprintln!("preview failed: {error}");
                std::process::exit(1);
            }
        }
    }
    if args == ["--atspi-inspect", "--guest-confirmed"] {
        std::process::exit(canaveral_guest_agent::atspi::run_worker(false));
    }
    if args == ["--atspi-action", "--guest-confirmed"] {
        std::process::exit(canaveral_guest_agent::atspi::run_worker(true));
    }
    let result = if args.iter().any(|arg| arg == "--worker-only") {
        if args
            .iter()
            .any(|arg| arg != "--worker-only" && arg != "--guest-confirmed")
        {
            Err("unknown classic worker argument".into())
        } else {
            canaveral_guest_agent::run_classic_worker()
        }
    } else if args.is_empty() {
        canaveral_guest_agent::run_pid1()
    } else {
        Err("unknown guest agent argument; default runtime requires Linux PID1".into())
    };
    if let Err(error) = result {
        eprintln!("guest agent fenced: {error}");
        std::process::exit(1);
    }
}
