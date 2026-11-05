//! PID1 guest agent. The production entry point never executes on a host.
use canaveral_guest_protocol::{Binding, Result};
use serde::Deserialize;
use std::collections::BTreeMap;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Launch {
    pub binding: Binding,
    pub workspace_bytes: u64,
    /// Exact output substrings expected from separately executed tool probes.
    pub tool_versions: BTreeMap<String, String>,
}
impl Launch {
    pub fn validate(&self) -> Result<()> {
        self.binding.validate()?;
        if !(16 * 1024 * 1024..=1024 * 1024 * 1024).contains(&self.workspace_bytes) {
            return Err("workspace capacity must be 16MiB..1GiB".into());
        }
        if self.tool_versions.len() != 3
            || ["git", "node", "python3"].iter().any(|k| {
                self.tool_versions
                    .get(*k)
                    .is_none_or(|s| s.is_empty() || s.len() > 128)
            })
        {
            return Err("missing tool pins".into());
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
