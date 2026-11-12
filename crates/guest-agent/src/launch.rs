//! Closed launch variants; v2 must never fall back to a legacy tmpfs boot.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]
use canaveral_guest_protocol::{
    bundle::{Launch, WorkspaceLaunch},
    Binding, Result,
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub(crate) enum BootLaunch {
    Workspace(WorkspaceLaunch),
    Legacy(Launch),
}
impl BootLaunch {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let launch: Self = serde_json::from_slice(bytes)?;
        match &launch {
            Self::Legacy(l) => l.validate()?,
            Self::Workspace(l) => l.validate()?,
        }
        Ok(launch)
    }
    pub fn binding(&self) -> &Binding {
        match self {
            Self::Legacy(l) => &l.binding,
            Self::Workspace(l) => &l.binding,
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn workspace_launch_is_closed_and_cannot_downgrade() {
        let bytes = include_bytes!("../../guest-protocol/fixtures/launch-v2.json");
        assert!(matches!(
            BootLaunch::parse(bytes).unwrap(),
            BootLaunch::Workspace(_)
        ));
        let mut v: serde_json::Value = serde_json::from_slice(bytes).unwrap();
        v["workspace"]["bytes"] = 1.into();
        assert!(BootLaunch::parse(&serde_json::to_vec(&v).unwrap()).is_err());
        v["workspaceBytes"] = 16777216.into();
        assert!(BootLaunch::parse(&serde_json::to_vec(&v).unwrap()).is_err());
    }
}
