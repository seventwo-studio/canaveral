use crate::{bounded, invalid, Api, Error, Result, Scope, LIMIT};
use reqwest::{
    blocking::Client,
    header::{HeaderMap, HeaderValue, AUTHORIZATION},
    redirect::Policy,
    Certificate, Method, Url,
};
use serde_json::Value;
use std::time::Duration;

/// Fixed HTTPS origin, explicit namespace/account, TLS validation and no redirects.
/// Bearer token is held only in a sensitive header; errors never contain URLs,
/// response bodies, headers or credentials. No kubeconfig exec plugins or shell.
pub struct Kubernetes {
    client: Client,
    origin: Url,
    scope: Scope,
    verified: bool,
}
impl Kubernetes {
    pub fn new(scope: Scope, token: &str, ca_pem: &[u8], timeout: Duration) -> Result<Self> {
        let origin = Url::parse(&scope.cluster_id).map_err(|_| invalid())?;
        if origin.scheme() != "https"
            || origin.host_str().is_none()
            || !origin.username().is_empty()
            || origin.password().is_some()
            || origin.query().is_some()
            || origin.fragment().is_some()
            || origin.path() != "/"
            || timeout.is_zero()
            || timeout > Duration::from_secs(20)
            || token.is_empty()
        {
            return Err(invalid());
        }
        let mut authorization =
            HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| invalid())?;
        authorization.set_sensitive(true);
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, authorization);
        let ca = Certificate::from_pem(ca_pem).map_err(|_| invalid())?;
        let client = Client::builder()
            .https_only(true)
            .no_proxy()
            .redirect(Policy::none())
            .default_headers(headers)
            .tls_built_in_root_certs(false)
            .add_root_certificate(ca)
            .timeout(timeout)
            .connect_timeout(timeout)
            .build()
            .map_err(|_| Error("TLS client configuration failed"))?;
        Ok(Self {
            client,
            origin,
            scope,
            verified: false,
        })
    }
}
impl Api for Kubernetes {
    fn scope(&self) -> &Scope {
        &self.scope
    }
    fn request(&mut self, method: &str, path: &str, body: Option<&Value>) -> Result<(u16, Value)> {
        validate_route(method, path, &self.scope.namespace)?;
        if !self.verified {
            let (code, review)=self.send("POST","/apis/authentication.k8s.io/v1/selfsubjectreviews",Some(&serde_json::json!({"apiVersion":"authentication.k8s.io/v1","kind":"SelfSubjectReview"})))?;
            let expected = format!(
                "system:serviceaccount:{}:{}",
                self.scope.namespace, self.scope.service_account
            );
            if ![200, 201].contains(&code) || review["status"]["userInfo"]["username"] != expected {
                return Err(Error("API account scope mismatch"));
            }
            self.verified = true;
        }
        self.send(method, path, body)
    }
}
impl Kubernetes {
    fn send(&self, method: &str, path: &str, body: Option<&Value>) -> Result<(u16, Value)> {
        let url = self.origin.join(path).map_err(|_| invalid())?;
        if url.origin() != self.origin.origin() {
            return Err(invalid());
        }
        let mut request = self.client.request(
            Method::from_bytes(method.as_bytes()).map_err(|_| invalid())?,
            url,
        );
        if method == "GET" && path.contains("?limit=100") {
            request = request.header(
                "Accept",
                "application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1",
            );
        }
        if let Some(v) = body {
            let bytes = serde_json::to_vec(v).map_err(|_| invalid())?;
            if bytes.len() > LIMIT {
                return Err(Error("request limit"));
            }
            request = request
                .header("Content-Type", "application/json")
                .body(bytes);
        }
        let response = request
            .send()
            .map_err(|_| Error("API transport outcome unknown"))?;
        let status = response.status().as_u16();
        let bytes = bounded(response)?;
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| Error("API response unknown"))?;
        if status == 200
            && method == "GET"
            && path.contains("?limit=100")
            && (value["kind"] != "PartialObjectMetadataList"
                || value["apiVersion"] != "meta.k8s.io/v1")
        {
            return Err(Error("metadata inventory unsupported"));
        }
        Ok((status, value))
    }
}

// The caller supplies a route, never a URL. Percent encoding is permitted only
// for an opaque pagination cursor; names and plurals have one canonical spelling.
pub(crate) fn encode_cursor(cursor: &str) -> String {
    cursor
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
fn validate_route(method: &str, path: &str, ns: &str) -> Result<()> {
    if !["GET", "POST", "DELETE"].contains(&method) {
        return Err(invalid());
    }
    let (route, query) = path
        .split_once('?')
        .map_or((path, None), |(r, q)| (r, Some(q)));
    let prefixes = [
        (
            format!("/api/v1/namespaces/{ns}/"),
            &["pods", "persistentvolumeclaims", "secrets"][..],
        ),
        (
            format!("/apis/kubevirt.io/v1/namespaces/{ns}/"),
            &["virtualmachines", "virtualmachineinstances"][..],
        ),
        (
            format!("/apis/snapshot.storage.k8s.io/v1/namespaces/{ns}/"),
            &["volumesnapshots"][..],
        ),
    ];
    let tail = prefixes
        .iter()
        .find_map(|(prefix, plurals)| route.strip_prefix(prefix).map(|tail| (tail, plurals)))
        .ok_or_else(invalid)?;
    let mut parts = tail.0.split('/');
    let plural = parts.next().ok_or_else(invalid)?;
    if !tail.1.contains(&plural) {
        return Err(invalid());
    }
    let name = parts.next();
    if parts.next().is_some() || name.is_some_and(|n| !crate::dns(n)) {
        return Err(invalid());
    }
    if let Some(q) = query {
        if method != "GET" || name.is_some() {
            return Err(invalid());
        }
        let cursor = q.strip_prefix("limit=100").ok_or_else(invalid)?;
        if !cursor.is_empty() {
            let encoded = cursor
                .strip_prefix("&continue=")
                .filter(|s| !s.is_empty())
                .ok_or_else(invalid)?;
            let decoded =
                reqwest::Url::parse(&format!("https://cursor.invalid/?continue={encoded}"))
                    .map_err(|_| invalid())?
                    .query_pairs()
                    .next()
                    .ok_or_else(invalid)?
                    .1
                    .into_owned();
            if encode_cursor(&decoded) != encoded {
                return Err(invalid());
            }
        }
    }
    Ok(())
}
