//! One durable claim at a time, using the public controller's outbound runner routes.
use super::*;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunnerConfig {
    pub controller: String,
    pub credential_file: PathBuf,
    pub binding: Binding,
    pub execution: Config,
    pub ca_file: Option<PathBuf>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Claim {
    binding: Binding,
    id: uuid::Uuid,
}
#[derive(Clone)]
struct Controller {
    client: Client,
    origin: String,
    secret: String,
}
impl Controller {
    fn post(&self, route: &str, body: serde_json::Value) -> Result<serde_json::Value> {
        self.post_with_timeout(route, body, Duration::from_secs(20))
    }
    fn post_with_timeout(
        &self,
        route: &str,
        body: serde_json::Value,
        timeout: Duration,
    ) -> Result<serde_json::Value> {
        let body = serde_json::to_vec(&body).map_err(|_| "controller encoding failed")?;
        if body.len() > 1024 * 1024 {
            return Err("controller request bound exceeded");
        }
        decode(
            self.client
                .post(format!("{}{route}", self.origin))
                .timeout(timeout)
                .bearer_auth(&self.secret)
                .header("Content-Type", "application/json")
                .body(body)
                .send()
                .map_err(|_| "controller reply lost; retain claim and receipt")?,
            1024 * 1024,
        )
    }
}
/// Runs at most one assignment. Reinvoke with the same private state after a lost reply.
/// Unresolved execution prevents new claims; no enrollment, recovery or capacity advertising.
pub fn run_once(config: RunnerConfig) -> Result<()> {
    let url = reqwest::Url::parse(&config.controller).map_err(|_| "invalid controller origin")?;
    let loopback = url
        .host_str()
        .and_then(|s| s.parse::<std::net::IpAddr>().ok())
        .is_some_and(|ip| ip.is_loopback());
    if !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
    {
        return Err("verified TLS or loopback origin required");
    }
    if config.binding.generation == 0 || config.binding.generation > 9_007_199_254_740_991 {
        return Err("invalid binding generation");
    }
    let secret = String::from_utf8(private::trust_file(&config.credential_file, true)?)
        .map_err(|_| "invalid credential")?
        .trim()
        .to_owned();
    if !(43..=128).contains(&secret.len())
        || !secret
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err("invalid credential");
    }
    let timeout = Duration::from_millis(config.execution.contact_ms.min(20_000));
    let mut builder = Client::builder()
        .retry(reqwest::retry::never())
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout);
    if let Some(path) = config.ca_file {
        let bytes = private::trust_file(&path, false)?;
        let certs = reqwest::Certificate::from_pem_bundle(&bytes).map_err(|_| "invalid CA")?;
        if certs.is_empty() {
            return Err("invalid CA");
        }
        for cert in certs {
            builder = builder.add_root_certificate(cert);
        }
    }
    let controller = Controller {
        client: builder.build().map_err(|_| "controller client failed")?,
        origin: config.controller.trim_end_matches('/').into(),
        secret,
    };
    let mut executor = Executor::open(config.execution.clone())?;
    if let Some(j) = executor.journal() {
        if j.binding != config.binding {
            return Err("state belongs to another binding");
        }
        if j.pending {
            report(&controller, j)?;
            executor.acknowledge()?;
            return Ok(());
        }
        if executor.blocked() {
            return Err("unknown execution requires reconciliation; reservations retained");
        }
    }
    executor.prepare(); // Staging is complete before any claim request.
    executor.staged.as_ref().map_err(|error| *error)?;
    let mut claim: Claim = match executor.directory.read_optional("claim.json")? {
        Some(bytes) => serde_json::from_slice(&bytes).map_err(|_| "corrupt claim")?,
        None => new_claim(config.binding.clone())?,
    };
    if claim.binding != config.binding {
        return Err("claim binding changed");
    }
    if executor
        .journal()
        .is_some_and(|j| j.assignment.claim_id == claim.id.to_string())
    {
        claim = new_claim(config.binding.clone())?;
    }
    executor.directory.write(
        "claim.json",
        "claim.next",
        &serde_json::to_vec(&claim).map_err(|_| "claim encoding failed")?,
    )?;
    let claim_started = clock::Clock::now();
    let response = controller.post(
        "/v1/runners/model-jobs/claim",
        serde_json::json!({"binding":config.binding,"claimId":claim.id}),
    )?;
    let value = response.get("assignment").ok_or("invalid claim response")?;
    if value.is_null() {
        return Ok(());
    }
    let assignment: Assignment =
        serde_json::from_value(value.clone()).map_err(|_| "invalid assignment")?;
    if assignment.claim_id != claim.id.to_string() {
        return Err("claim identity mismatch");
    }
    let expected = assignment.clone();
    let mut last_contact = claim_started;
    let mut last_poll = clock::Clock::now();
    let mut poll: Option<(
        clock::Clock,
        std::sync::mpsc::Receiver<Result<serde_json::Value>>,
    )> = None;
    let j = executor.execute(config.binding.clone(), assignment, || {
        if last_contact.elapsed() >= timeout {
            return Control::Fence;
        }
        if poll.is_none() && last_poll.elapsed() >= Duration::from_millis(100) {
            let started = clock::Clock::now();
            last_poll = started;
            let c = controller.clone();
            let body = serde_json::json!({"binding":config.binding});
            let remaining = timeout.saturating_sub(last_contact.elapsed());
            let (tx, rx) = std::sync::mpsc::sync_channel(1);
            std::thread::spawn(move || {
                let _ = tx.send(c.post_with_timeout(
                    "/v1/runners/model-jobs/assignments",
                    body,
                    remaining,
                ));
            });
            poll = Some((started, rx));
        }
        let Some((started, rx)) = &poll else {
            return Control::Continue;
        };
        let started = *started;
        let response = match rx.try_recv() {
            Ok(v) => v,
            Err(std::sync::mpsc::TryRecvError::Empty) => return Control::Continue,
            Err(_) => return Control::Fence,
        };
        poll = None;
        match response {
            Ok(v) => {
                if last_contact.elapsed() >= timeout {
                    return Control::Fence;
                }
                let assignments: Vec<Assignment> = match v
                    .get("assignments")
                    .cloned()
                    .and_then(|a| serde_json::from_value(a).ok())
                {
                    Some(a) => a,
                    None => return Control::Fence,
                };
                let Some(current) = assignments.iter().find(|a| a.id == expected.id) else {
                    return Control::Fence;
                };
                if current.job != expected.job
                    || current.claim_id != expected.claim_id
                    || current.domain_id != expected.domain_id
                    || current.sequence != expected.sequence
                    || current.closed
                {
                    return Control::Fence;
                }
                last_contact = started;
                if current.cancel_requested {
                    Control::Cancel
                } else {
                    Control::Continue
                }
            }
            Err(_) => Control::Fence,
        }
    })?;
    report(&controller, j)?;
    executor.acknowledge()
}
fn new_claim(binding: Binding) -> Result<Claim> {
    let mut bytes = [0; 16];
    getrandom::fill(&mut bytes).map_err(|_| "randomness unavailable")?;
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    Ok(Claim {
        binding,
        id: uuid::Uuid::from_bytes(bytes),
    })
}
fn report(c: &Controller, j: &Journal) -> Result<()> {
    let v=c.post("/v1/runners/model-jobs/report",serde_json::json!({"binding":j.binding,"assignmentId":j.assignment.id,"sequence":j.sequence,"receipt":j.receipt}))?;
    let Message::Receipt {
        state,
        cancel_requested,
        stopped,
        cleanup,
        ..
    } = &j.receipt.message
    else {
        return Err("invalid stored report");
    };
    if v.get("assignmentId") != Some(&serde_json::json!(j.assignment.id))
        || v.get("sequence") != Some(&serde_json::json!(j.sequence))
        || v.get("state") != Some(&serde_json::json!(state))
        || !v
            .get("cancelRequested")
            .and_then(|v| v.as_bool())
            .is_some_and(|current| current || !cancel_requested)
        || v.get("stopped") != Some(&serde_json::json!(stopped))
        || v.get("cleanup") != Some(&serde_json::json!(cleanup))
        || v.get("released") != Some(&serde_json::json!(j.receipt.can_release()))
    {
        return Err("report acknowledgement mismatch");
    }
    Ok(())
}
