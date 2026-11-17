//! Operator-only acceleration policy; the runtime discovers compatible accelerators.
use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Acceleration {
    #[default]
    Auto,
    Cpu,
}

impl Acceleration {
    pub(crate) fn configure(self, command: &mut Command) {
        if self == Self::Cpu {
            command
                .env("CUDA_VISIBLE_DEVICES", "-1")
                .env("ROCR_VISIBLE_DEVICES", "-1")
                .env("GGML_VK_VISIBLE_DEVICES", "-1")
                .env("OLLAMA_VULKAN", "0");
        }
    }

    pub(crate) fn options(self, context_tokens: u64, max_tokens: u64) -> serde_json::Value {
        let mut options = serde_json::json!({
            "num_predict": max_tokens,
            "num_ctx": context_tokens,
        });
        if self == Self::Cpu {
            options["num_gpu"] = serde_json::json!(0);
        }
        options
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_disables_accelerators_and_auto_leaves_discovery_to_runtime() {
        for policy in [Acceleration::Auto, Acceleration::Cpu] {
            let mut command = Command::new("operator-runtime");
            policy.configure(&mut command);
            let env: Vec<_> = command.get_envs().collect();
            let options = policy.options(8192, 64);
            assert_eq!(options["num_ctx"], 8192);
            assert_eq!(options["num_predict"], 64);
            if policy == Acceleration::Cpu {
                assert_eq!(env.len(), 4);
                assert_eq!(options["num_gpu"], 0);
                assert!(env.iter().all(|(key, value)| {
                    *value
                        == Some(std::ffi::OsStr::new(if *key == "OLLAMA_VULKAN" {
                            "0"
                        } else {
                            "-1"
                        }))
                }));
            } else {
                assert!(env.is_empty());
                assert!(options.get("num_gpu").is_none());
            }
        }
        assert!(serde_json::from_str::<Acceleration>("\"cuda\"").is_err());
    }
}
