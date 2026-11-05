//! Bounded framing and launch-bound guest messages. No host execution.
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, io};
use uuid::Uuid;
pub const MAX_FRAME: usize = 1_048_576;
pub const MAX_SAFE: u64 = 9_007_199_254_740_991;
pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
fn uuid<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Uuid, D::Error> {
    let s = String::deserialize(d)?;
    let id = Uuid::parse_str(&s).map_err(serde::de::Error::custom)?;
    if id.hyphenated().to_string() != s || id.is_nil() {
        return Err(serde::de::Error::custom("noncanonical UUID"));
    }
    Ok(id)
}
/// Reject duplicate JSON map keys before a map can discard them.
pub fn unique_map<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<BTreeMap<String, String>, D::Error> {
    struct Unique;
    impl<'de> serde::de::Visitor<'de> for Unique {
        type Value = BTreeMap<String, String>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("unique string keys")
        }
        fn visit_map<M: serde::de::MapAccess<'de>>(
            self,
            mut m: M,
        ) -> std::result::Result<Self::Value, M::Error> {
            let mut out = BTreeMap::new();
            while let Some((k, v)) = m.next_entry::<String, String>()? {
                if out.insert(k, v).is_some() {
                    return Err(serde::de::Error::custom("duplicate key"));
                }
            }
            Ok(out)
        }
    }
    d.deserialize_map(Unique)
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    #[serde(deserialize_with = "uuid")]
    pub lease_id: Uuid,
    #[serde(deserialize_with = "uuid")]
    pub member_id: Uuid,
    pub revision: u64,
    #[serde(deserialize_with = "uuid")]
    pub boot_attempt: Uuid,
    pub bundle_digest: String,
}
impl Binding {
    pub fn validate(&self) -> Result<()> {
        if self.revision == 0
            || self.revision > MAX_SAFE
            || self.bundle_digest.len() != 64
            || !self
                .bundle_digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("invalid binding".into());
        }
        Ok(())
    }
    pub fn same_launch(&self, other: &Self) -> bool {
        self.lease_id == other.lease_id
            && self.member_id == other.member_id
            && self.boot_attempt == other.boot_attempt
            && self.bundle_digest == other.bundle_digest
    }
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Host {
    Hello {
        version: u32,
        binding: Binding,
        #[serde(rename = "remainingMs")]
        remaining_ms: u64,
    },
    Renew {
        version: u32,
        binding: Binding,
        #[serde(rename = "remainingMs")]
        remaining_ms: u64,
    },
    Exec {
        version: u32,
        #[serde(deserialize_with = "uuid")]
        id: Uuid,
        argv: Vec<String>,
        cwd: String,
        #[serde(deserialize_with = "unique_map")]
        env: BTreeMap<String, String>,
        #[serde(rename = "timeoutMs")]
        timeout_ms: u64,
    },
    Credit {
        version: u32,
        bytes: u64,
    },
    Cancel {
        version: u32,
        #[serde(deserialize_with = "uuid")]
        id: Uuid,
    },
}
impl Host {
    pub fn validate(&self) -> Result<()> {
        let version = match self {
            Self::Hello {
                version,
                binding,
                remaining_ms,
            }
            | Self::Renew {
                version,
                binding,
                remaining_ms,
            } => {
                binding.validate()?;
                positive(*remaining_ms)?;
                *version
            }
            Self::Exec {
                version,
                argv,
                cwd,
                env,
                timeout_ms,
                ..
            } => {
                positive(*timeout_ms)?;
                if argv.is_empty()
                    || argv[0].is_empty()
                    || argv.iter().any(|s| s.contains('\0'))
                    || !(cwd == "/workspace" || cwd.starts_with("/workspace/"))
                    || cwd.contains('\0')
                    || env.iter().any(|(k, v)| {
                        k == "PATH" || k.is_empty() || k.contains(['=', '\0']) || v.contains('\0')
                    })
                {
                    return Err("invalid exec".into());
                }
                *version
            }
            Self::Credit { version, bytes } => {
                if *bytes == 0 || *bytes > MAX_FRAME as u64 {
                    return Err("invalid credit".into());
                }
                *version
            }
            Self::Cancel { version, .. } => *version,
        };
        if version != 1 {
            return Err("unsupported protocol".into());
        }
        Ok(())
    }
}
fn positive(n: u64) -> Result<()> {
    if n == 0 || n > MAX_SAFE {
        Err("invalid duration".into())
    } else {
        Ok(())
    }
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Guest {
    SpawnFailed {
        version: u32,
        id: Uuid,
    },
    Rejected {
        version: u32,
        id: Uuid,
        reason: String,
    },
    Ready {
        version: u32,
        binding: Binding,
    },
    Output {
        version: u32,
        id: Uuid,
        stream: String,
        seq: u64,
        data: String,
    },
    Exit {
        version: u32,
        id: Uuid,
        status: Option<i32>,
        signal: Option<i32>,
        #[serde(rename = "timedOut")]
        timed_out: bool,
        #[serde(rename = "durationMs")]
        duration_ms: u64,
        #[serde(rename = "stdoutBytes")]
        stdout_bytes: u64,
        #[serde(rename = "stderrBytes")]
        stderr_bytes: u64,
        #[serde(rename = "terminationConfirmed")]
        termination_confirmed: bool,
    },
}
impl Guest {
    /// Version and field checks; binding equality is the receiver's launch decision.
    pub fn validate(&self) -> Result<()> {
        let version = match self {
            Self::SpawnFailed { version, .. } | Self::Exit { version, .. } => *version,
            Self::Rejected {
                version, reason, ..
            } => {
                if reason.is_empty() || reason.len() > 64 {
                    return Err("invalid rejection".into());
                }
                *version
            }
            Self::Ready { version, binding } => {
                binding.validate()?;
                *version
            }
            Self::Output {
                version, stream, ..
            } => {
                if stream != "stdout" && stream != "stderr" {
                    return Err("invalid output stream".into());
                }
                *version
            }
        };
        if version != 1 {
            return Err("unsupported protocol".into());
        }
        Ok(())
    }
}
pub fn encode(value: &impl Serialize) -> Result<Vec<u8>> {
    let json = serde_json::to_vec(value)?;
    if json.is_empty() || json.len() > MAX_FRAME {
        return Err("frame too large".into());
    }
    let mut frame = (json.len() as u32).to_be_bytes().to_vec();
    frame.extend(json);
    Ok(frame)
}
/// Incremental frame reader: caller feeds at most `needed()` bytes, so memory is bounded.
#[derive(Default)]
pub struct Frames {
    bytes: Vec<u8>,
    length: Option<usize>,
}
impl Frames {
    pub fn needed(&self) -> usize {
        self.length.unwrap_or(4) - self.bytes.len()
    }
    /// Returns one complete JSON body once its length-prefixed frame is complete.
    pub fn feed(&mut self, bytes: &[u8]) -> Result<Option<Vec<u8>>> {
        if bytes.len() > self.needed() {
            return Err("decoder overfeed".into());
        }
        self.bytes.extend_from_slice(bytes);
        if self.needed() != 0 {
            return Ok(None);
        }
        if self.length.is_none() {
            let n = u32::from_be_bytes(self.bytes[..].try_into()?) as usize;
            if n == 0 || n > MAX_FRAME {
                return Err(
                    io::Error::new(io::ErrorKind::InvalidData, "invalid frame length").into(),
                );
            }
            self.bytes.clear();
            self.length = Some(n);
            return Ok(None);
        }
        self.length = None;
        Ok(Some(std::mem::take(&mut self.bytes)))
    }
}
/// Guest-side decoder of host frames.
#[derive(Default)]
pub struct Decoder(Frames);
impl Decoder {
    pub fn needed(&self) -> usize {
        self.0.needed()
    }
    pub fn feed(&mut self, bytes: &[u8]) -> Result<Option<Host>> {
        let Some(body) = self.0.feed(bytes)? else {
            return Ok(None);
        };
        let value: Host = serde_json::from_slice(&body)?;
        value.validate()?;
        Ok(Some(value))
    }
}
/// Host-side decoder of guest frames, with the same bounds and strict schema.
#[derive(Default)]
pub struct GuestDecoder(Frames);
impl GuestDecoder {
    pub fn needed(&self) -> usize {
        self.0.needed()
    }
    pub fn feed(&mut self, bytes: &[u8]) -> Result<Option<Guest>> {
        let Some(body) = self.0.feed(bytes)? else {
            return Ok(None);
        };
        let value: Guest = serde_json::from_slice(&body)?;
        value.validate()?;
        Ok(Some(value))
    }
}
/// Sticky deadline in a caller-supplied suspend-aware clock domain (milliseconds).
pub struct Authority {
    pub binding: Binding,
    deadline: u64,
    fenced: bool,
}
impl Authority {
    pub fn new(binding: Binding, remaining: u64, now: u64) -> Result<Self> {
        binding.validate()?;
        positive(remaining)?;
        Ok(Self {
            binding,
            deadline: now.checked_add(remaining).ok_or("deadline overflow")?,
            fenced: false,
        })
    }
    pub fn deadline(&self) -> u64 {
        self.deadline
    }
    pub fn permits(&mut self, now: u64) -> bool {
        self.fenced |= now >= self.deadline;
        !self.fenced
    }
    pub fn fence(&mut self) {
        self.fenced = true;
    }
    pub fn renew(&mut self, binding: Binding, remaining: u64, now: u64) -> Result<()> {
        binding.validate()?;
        positive(remaining)?;
        if !self.permits(now)
            || !binding.same_launch(&self.binding)
            || binding.revision <= self.binding.revision
        {
            self.fence();
            return Err("renewal denied".into());
        }
        self.deadline = now.checked_add(remaining).ok_or("deadline overflow")?;
        self.binding = binding;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn binding() -> Binding {
        Binding {
            lease_id: Uuid::from_u128(1),
            member_id: Uuid::from_u128(2),
            boot_attempt: Uuid::from_u128(3),
            revision: 1,
            bundle_digest: "a".repeat(64),
        }
    }
    #[test]
    fn duplicate_env_and_fixed_path() {
        let prefix = r#"{"type":"exec","version":1,"id":"00000000-0000-0000-0000-000000000001","argv":["sh"],"cwd":"/workspace","timeoutMs":1,"env":{ENV}}"#;
        for env in [r#""A":"1","A":"2""#, r#""PATH":"/evil""#] {
            let value = prefix.replace("ENV", env);
            let result = serde_json::from_str::<Host>(&value);
            assert!(result.is_err() || result.unwrap().validate().is_err());
        }
        let valid = prefix.replace("ENV", r#""UNICODE":"é""#);
        serde_json::from_str::<Host>(&valid)
            .unwrap()
            .validate()
            .unwrap();
    }
    #[test]
    fn expiry_is_sticky_and_renewal_is_scoped() {
        let mut a = Authority::new(binding(), 10, 100).unwrap();
        let mut b = binding();
        b.revision = 2;
        assert!(a.permits(109));
        assert!(!a.permits(110));
        assert!(a.renew(b.clone(), 100, 110).is_err());
        assert!(!a.permits(1));
        let mut a = Authority::new(binding(), 10, 100).unwrap();
        a.renew(b.clone(), 20, 105).unwrap();
        assert!(a.permits(124));
        b.member_id = Uuid::from_u128(8);
        b.revision = 3;
        assert!(a.renew(b, 100, 124).is_err());
    }
    #[test]
    fn fragmented_and_malformed_frames() {
        let bytes = encode(&Host::Credit {
            version: 1,
            bytes: 10,
        })
        .unwrap();
        let mut d = Decoder::default();
        let mut count = 0;
        for b in bytes {
            if d.feed(&[b]).unwrap().is_some() {
                count += 1;
            }
        }
        assert_eq!(count, 1);
        for n in [0, MAX_FRAME as u32 + 1] {
            assert!(Decoder::default().feed(&n.to_be_bytes()).is_err());
        }
        let ready = encode(&Guest::Ready {
            version: 1,
            binding: binding(),
        })
        .unwrap();
        let mut g = GuestDecoder::default();
        let mut seen = None;
        for b in ready {
            seen = g.feed(&[b]).unwrap().or(seen);
        }
        assert!(matches!(seen, Some(Guest::Ready { binding: b, .. }) if b == binding()));
        for s in [
            r#"{"type":"ready","version":2,"binding":{"leaseId":"00000000-0000-0000-0000-000000000001","memberId":"00000000-0000-0000-0000-000000000002","revision":1,"bootAttempt":"00000000-0000-0000-0000-000000000003","bundleDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}"#,
            r#"{"type":"output","version":1,"id":"00000000-0000-0000-0000-000000000001","stream":"tty","seq":0,"data":""}"#,
        ] {
            let mut g = GuestDecoder::default();
            g.feed(&(s.len() as u32).to_be_bytes()).unwrap();
            assert!(g.feed(s.as_bytes()).is_err());
        }
        for s in [
            r#"{"type":"credit","version":2,"bytes":1}"#,
            r#"{"type":"credit","version":1,"bytes":1,"extra":0}"#,
            r#"{"type":"cancel","version":1,"id":"bad"}"#,
        ] {
            let mut d = Decoder::default();
            d.feed(&(s.len() as u32).to_be_bytes()).unwrap();
            assert!(d.feed(s.as_bytes()).is_err());
        }
    }
}

pub mod bundle;
