//! PID1 guest agent. The production entry point never executes on a host.
pub use canaveral_guest_protocol::bundle::Launch;
use canaveral_guest_protocol::Result;
#[cfg(target_os = "linux")]
mod boot;
#[cfg(unix)]
mod runtime;
pub fn run_pid1() -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        if std::process::id() != 1 {
            return Err("guest agent requires Linux PID1".into());
        }
        boot::run()
    }
    #[cfg(not(target_os = "linux"))]
    Err("guest agent requires Linux PID1".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use canaveral_guest_protocol::{bundle::Manifest, Binding};
    #[test]
    fn launch_pins_are_bound_to_manifest_digest() {
        let manifest: Manifest = serde_json::from_slice(include_bytes!(
            "../../guest-protocol/fixtures/canonical.json"
        ))
        .unwrap();
        let mut launch = Launch {
            binding: Binding {
                lease_id: uuid::Uuid::from_u128(1),
                member_id: uuid::Uuid::from_u128(2),
                revision: 1,
                boot_attempt: uuid::Uuid::from_u128(3),
                bundle_digest: manifest.digest().unwrap(),
            },
            workspace_bytes: 16777216,
            manifest,
        };
        launch.validate().unwrap();
        // The host serializes exactly what the guest parses.
        let round: Launch = serde_json::from_slice(&launch.to_bytes().unwrap()).unwrap();
        round.validate().unwrap();
        launch
            .manifest
            .tool_versions
            .insert("git".into(), "different".into());
        assert!(launch.validate().is_err());
    }
}

mod classic;
/// Explicit classic worker mode. Never used by the protocol 1 bootstrap.
pub use classic::run as run_classic_worker;

pub mod atspi;

pub mod workspace;

#[cfg(any(target_os = "linux", test))]
mod launch;
#[cfg(target_os = "linux")]
mod workspace_boot;
