fn main() {
    if let Err(error) = canaveral_guest_agent::run_pid1() {
        eprintln!("guest agent fenced: {error}");
        std::process::exit(1);
    }
}
