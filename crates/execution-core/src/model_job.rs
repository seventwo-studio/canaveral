//! Experimental model-job/1 data validation; no executor or durable ledger.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "RawJob")]
pub struct ModelJob {
    pub version: u64,
    #[serde(rename = "applicationId")]
    pub application_id: String,
    pub id: String,
    pub message: Message,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawJob {
    #[serde(deserialize_with = "integer")]
    version: u64,
    application_id: String,
    id: String,
    message: Message,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Message {
    Submit {
        adapter: String,
        model: String,
        digest: String,
        prompt: String,
        #[serde(rename = "maxTokens", deserialize_with = "integer")]
        max_tokens: u64,
    },
    Cancel {},
    Receipt {
        state: State,
        #[serde(rename = "cancelRequested")]
        cancel_requested: bool,
        stopped: bool,
        cleanup: Cleanup,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "present_result"
        )]
        result: Option<GenerationResult>,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerationResult {
    pub model: String,
    pub text: String,
    pub usage: Usage,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Usage {
    #[serde(deserialize_with = "integer")]
    pub input_tokens: u64,
    #[serde(deserialize_with = "integer")]
    pub output_tokens: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Queued,
    WaitingForResources,
    Running,
    Unknown,
    Succeeded,
    Failed,
    Cancelled,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Cleanup {
    Pending,
    Complete,
}
impl State {
    fn terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
}
impl TryFrom<RawJob> for ModelJob {
    type Error = &'static str;
    fn try_from(raw: RawJob) -> Result<Self, Self::Error> {
        let job = Self {
            version: raw.version,
            application_id: raw.application_id,
            id: raw.id,
            message: raw.message,
        };
        job.validate()?;
        Ok(job)
    }
}
impl ModelJob {
    pub fn validate(&self) -> Result<(), &'static str> {
        let valid = self.version == 1
            && uuid(&self.application_id)
            && uuid(&self.id)
            && match &self.message {
                Message::Submit {
                    adapter,
                    model,
                    digest,
                    prompt,
                    max_tokens,
                } => {
                    adapter == "ollama"
                        && model_name(model)
                        && digest.len() == 71
                        && digest.starts_with("sha256:")
                        && digest[7..]
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                        && prompt.len() <= 65536
                        && prompt.chars().any(|c| !matches!(c, '\t'..='\r' | ' '))
                        && (1..=4096).contains(max_tokens)
                }
                Message::Cancel {} => true,
                Message::Receipt {
                    state,
                    cancel_requested,
                    stopped,
                    cleanup,
                    result,
                } => {
                    (state.terminal() || (!stopped && *cleanup == Cleanup::Pending))
                        && (*cleanup != Cleanup::Complete || *stopped)
                        && (*state != State::Cancelled || (*cancel_requested && *stopped))
                        && match (state, result) {
                            (State::Succeeded, Some(r)) => {
                                model_name(&r.model)
                                    && r.text.len() <= 131072
                                    && r.usage.input_tokens <= 2147483648
                                    && r.usage.output_tokens <= 2147483648
                            }
                            (State::Succeeded, None) => false,
                            (_, None) => true,
                            (_, Some(_)) => false,
                        }
                }
            };
        if valid {
            Ok(())
        } else {
            Err("Invalid model job version, identity or message")
        }
    }
    pub fn owns(&self, authenticated_application_id: &str) -> bool {
        self.validate().is_ok() && self.application_id == authenticated_application_id
    }
    pub fn same_submission(&self, other: &Self) -> bool {
        self.validate().is_ok()
            && other.validate().is_ok()
            && matches!(self.message, Message::Submit { .. })
            && self == other
    }
    /// Bind to a stored submission; authentication and durable reconciliation remain external.
    pub fn receipt_matches(&self, receipt: &Self) -> bool {
        if self.validate().is_err()
            || receipt.validate().is_err()
            || self.application_id != receipt.application_id
            || self.id != receipt.id
        {
            return false;
        }
        match (&self.message, &receipt.message) {
            (Message::Submit { model, .. }, Message::Receipt { result, .. }) => match result {
                Some(r) => r.model == *model,
                None => true,
            },
            _ => false,
        }
    }
    /// Eligibility only, never proof of authenticated stop or durable cleanup.
    pub fn can_release(&self) -> bool {
        self.validate().is_ok()
            && matches!(&self.message, Message::Receipt { state, stopped: true, cleanup: Cleanup::Complete, .. } if state.terminal())
    }
}
fn uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}
fn model_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:/-".contains(&b))
        && !value.to_ascii_lowercase().contains("cloud")
}
fn integer<'de, D: serde::Deserializer<'de>>(reader: D) -> Result<u64, D::Error> {
    let number = serde_json::Number::deserialize(reader)?;
    let n = number
        .as_f64()
        .ok_or_else(|| serde::de::Error::custom("Invalid integer"))?;
    if !(0.0..=9_007_199_254_740_991.0).contains(&n) || n.fract() != 0.0 {
        return Err(serde::de::Error::custom("Unsafe integer"));
    }
    Ok(n as u64)
}
fn present_result<'de, D: serde::Deserializer<'de>>(
    reader: D,
) -> Result<Option<GenerationResult>, D::Error> {
    GenerationResult::deserialize(reader).map(Some)
}
