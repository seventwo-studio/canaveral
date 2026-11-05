//! PID1 guest agent. The production entry point never executes on a host.
use canaveral_guest_protocol::bundle::Manifest;
use canaveral_guest_protocol::{Binding, Result};
use serde::Deserialize;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Launch {
    pub binding: Binding,
    pub workspace_bytes: u64,
    /// Canonical manifest supplied on the trusted per-launch medium.
    pub manifest: Manifest,
}
impl Launch {
    pub fn validate(&self) -> Result<()> {
        self.binding.validate()?;
        if !(16 * 1024 * 1024..=1024 * 1024 * 1024).contains(&self.workspace_bytes) {
            return Err("workspace capacity must be 16MiB..1GiB".into());
        }
        if self.manifest.digest()? != self.binding.bundle_digest {
            return Err("manifest binding mismatch".into());
        }
        Ok(())
    }
}
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
        launch
            .manifest
            .tool_versions
            .insert("git".into(), "different".into());
        assert!(launch.validate().is_err());
    }
}
