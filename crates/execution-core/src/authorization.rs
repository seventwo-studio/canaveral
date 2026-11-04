//! Assignment-bound native authorization, matching lease-authorization.json.
//! The caller must serialize updates and durably publish before execution.
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeAuthorization {
    #[serde(deserialize_with = "safe_integer")]
    pub version: u64,
    #[serde(rename = "machineID", deserialize_with = "canonical_uuid")]
    pub machine_id: Uuid,
    #[serde(rename = "leaseID", deserialize_with = "canonical_uuid")]
    pub lease_id: Uuid,
    #[serde(deserialize_with = "safe_integer")]
    pub revision: u64,
    pub boot: f64,
    #[serde(rename = "bootSessionID", deserialize_with = "canonical_uuid")]
    pub boot_session_id: Uuid,
    pub deadline: f64,
    pub fenced: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AuthorizationError {
    InvalidRecord,
    InvalidClock,
    OwnershipChanged,
    RevisionRegressed,
}

impl NativeAuthorization {
    pub fn validate(&self) -> Result<(), AuthorizationError> {
        if self.version != 1
            || !(1..=MAX_SAFE_INTEGER).contains(&self.revision)
            || !valid_time(self.boot)
            || !valid_time(self.deadline)
        {
            return Err(AuthorizationError::InvalidRecord);
        }
        Ok(())
    }

    /// Do not extend same-revision authority, change owners/boots or revive a fence.
    /// This returns a candidate, not a durable receipt or proof of native stop.
    pub fn constrain(mut self, previous: Option<&Self>) -> Result<Self, AuthorizationError> {
        self.validate()?;
        if let Some(old) = previous {
            old.validate()?;
            if self.machine_id != old.machine_id
                || self.lease_id != old.lease_id
                || self.boot != old.boot
                || self.boot_session_id != old.boot_session_id
            {
                return Err(AuthorizationError::OwnershipChanged);
            }
            if self.revision < old.revision {
                return Err(AuthorizationError::RevisionRegressed);
            }
            self.fenced |= old.fenced;
            if self.revision == old.revision {
                self.deadline = self.deadline.min(old.deadline);
            }
        }
        Ok(self)
    }

    /// A consumer must supply its current pinned boot scope and continuous clock.
    /// Failure is a denial, never a reason to fall back to wall-clock execution.
    pub fn permits(&self, scope: &ExecutionScope, continuous: f64) -> bool {
        self.validate().is_ok()
            && valid_time(continuous)
            && !self.fenced
            && self.machine_id == scope.machine_id
            && self.lease_id == scope.lease_id
            && self.boot == scope.boot
            && self.boot_session_id == scope.boot_session_id
            && continuous < self.deadline
    }
}

#[derive(Clone, Debug)]
pub struct ExecutionScope {
    pub machine_id: Uuid,
    pub lease_id: Uuid,
    pub boot: f64,
    pub boot_session_id: Uuid,
}

/// Deduct sampling latency and the existing 250ms native publication margin.
pub fn conservative_deadline(
    continuous: f64,
    remaining_seconds: f64,
    elapsed: f64,
) -> Result<f64, AuthorizationError> {
    if !valid_time(continuous) || !valid_time(remaining_seconds) || !valid_time(elapsed) {
        return Err(AuthorizationError::InvalidClock);
    }
    let deadline = (continuous + remaining_seconds - elapsed - 0.25).max(0.0);
    if !valid_time(deadline) {
        return Err(AuthorizationError::InvalidClock);
    }
    Ok(deadline)
}

fn valid_time(value: f64) -> bool {
    value.is_finite() && (0.0..=MAX_SAFE_INTEGER as f64).contains(&value)
}

fn canonical_uuid<'de, D: serde::Deserializer<'de>>(reader: D) -> Result<Uuid, D::Error> {
    let value = String::deserialize(reader)?;
    let parsed = Uuid::parse_str(&value).map_err(serde::de::Error::custom)?;
    if value.to_ascii_lowercase() != parsed.to_string() {
        return Err(serde::de::Error::custom(
            "UUID must use the hyphenated wire format",
        ));
    }
    Ok(parsed)
}

fn safe_integer<'de, D: serde::Deserializer<'de>>(reader: D) -> Result<u64, D::Error> {
    let number = serde_json::Number::deserialize(reader)?;
    let value = number
        .as_f64()
        .ok_or_else(|| serde::de::Error::custom("Invalid integer"))?;
    if !valid_time(value) || value.fract() != 0.0 {
        return Err(serde::de::Error::custom(
            "Integer exceeds the shared wire range",
        ));
    }
    Ok(value as u64)
}
