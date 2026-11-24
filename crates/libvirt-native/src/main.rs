//! canaveral-libvirt-native: the Linux libvirt lease guardian and its fence and erase commands.
#[cfg(target_os = "linux")]
mod guardian;
#[cfg(target_os = "linux")]
mod journal;
#[cfg(target_os = "linux")]
mod native;
#[cfg(target_os = "linux")]
mod storage;

fn main() {
    #[cfg(target_os = "linux")]
    match guardian::run() {
        Ok(()) => return,
        Err(error) => {
            if let Some(guardian::Exit(code)) = error.downcast_ref::<guardian::Exit>() {
                std::process::exit(*code);
            }
            eprintln!("libvirt lease operation is unconfirmed");
        }
    }
    #[cfg(not(target_os = "linux"))]
    eprintln!("libvirt lease supervision requires Linux");
    std::process::exit(1);
}
