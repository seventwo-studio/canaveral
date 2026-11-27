#[cfg(any(target_os = "linux", all(test, target_os = "macos")))]
mod installer;
#[cfg(any(target_os = "linux", all(test, target_os = "macos")))]
mod pins;
#[cfg(target_os = "linux")]
mod system;

fn main() -> std::process::ExitCode {
    #[cfg(target_os = "linux")]
    {
        // No threads have been started. Drop resolver, TLS and other inherited
        // settings before constructing clients or starting child processes.
        if unsafe { libc::clearenv() } != 0 {
            eprintln!("unsafe_environment: could not clear the process environment");
            return std::process::ExitCode::from(2);
        }
        installer::cli(&system::Linux)
    }
    #[cfg(not(target_os = "linux"))]
    {
        eprintln!("unsupported_platform: the host installer requires Linux amd64 or arm64");
        std::process::ExitCode::from(2)
    }
}
