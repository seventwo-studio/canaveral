//! Bounded AT-SPI worker. Native calls use libatspi's D-Bus client in a short-lived guest process.
use canaveral_guest_protocol::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

#[cfg(unix)]
mod native;
pub const MAX_BYTES: usize = 6 * 1048576;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Details {
    pub role: String,
    pub name: String,
    pub identifier: String,
    pub states: Vec<String>,
    pub actions: Vec<String>,
    pub bounds: Option<Bounds>,
    pub properties: BTreeMap<String, Value>,
}
impl PartialEq for Details {
    fn eq(&self, other: &Self) -> bool {
        self.role == other.role
            && self.name == other.name
            && self.identifier == other.identifier
            && self.states == other.states
            && self.actions == other.actions
            && self.bounds == other.bounds
            && self.properties.len() == other.properties.len()
            && self.properties.iter().all(|(key, value)| {
                other.properties.get(key).is_some_and(|other| {
                    // Native values are doubles. A JavaScript round trip serializes 0.0 as 0;
                    // JSON's integer/float representation must not invalidate unchanged native data.
                    match (value, other) {
                        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
                        _ => value == other,
                    }
                })
            })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: String,
    pub parent_id: Option<String>,
    pub depth: usize,
    pub path: Vec<u32>,
    #[serde(flatten)]
    pub details: Details,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub nodes: Vec<Node>,
    pub truncated: bool,
    pub unavailable_nodes: usize,
    // CLOCK_BOOTTIME timestamps are used unchanged by the subsequent worker process.
    pub started_at: f64,
    pub expires_at: f64,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ActionContext {
    pub chain: Vec<Node>,
    pub action: String,
    pub started_at: f64,
    pub expires_at: f64,
}
/// Opaque handles retain their native references through validation and the single invocation.
pub trait Api {
    type Handle;
    fn desktop(&self) -> Result<Self::Handle>;
    fn describe(&self, object: &Self::Handle) -> Result<Details>;
    fn child_count(&self, object: &Self::Handle) -> Result<usize>;
    fn child(&self, object: &Self::Handle, index: u32) -> Result<Self::Handle>;
    fn actions(&self, object: &Self::Handle) -> Result<(Self::Handle, Vec<String>)>;
    fn invoke(&self, object: &Self::Handle, index: usize) -> Result<bool>;
}

pub fn capture(api: &impl Api, clock: impl Fn() -> f64) -> Result<Snapshot> {
    let started_at = clock();
    let mut result = Snapshot {
        nodes: Vec::new(),
        truncated: false,
        unavailable_nodes: 0,
        started_at,
        expires_at: started_at + 15.0,
    };
    let mut bytes = 0;
    fn walk<A: Api>(
        api: &A,
        object: A::Handle,
        path: Vec<u32>,
        parent: Option<String>,
        clock: &impl Fn() -> f64,
        result: &mut Snapshot,
        bytes: &mut usize,
    ) {
        if result.nodes.len() >= 1500 || path.len() > 25 || clock() >= result.started_at + 3.0 {
            result.truncated = true;
            return;
        }
        let details = match api.describe(&object) {
            Ok(details) => details,
            Err(_) => {
                result.unavailable_nodes += 1;
                return;
            }
        };
        let node = Node {
            id: format!("ax-{}", result.nodes.len() + 1),
            parent_id: parent,
            depth: path.len(),
            path: path.clone(),
            details,
        };
        let size = serde_json::to_vec(&node).map_or(MAX_BYTES, |v| v.len());
        if *bytes + size > MAX_BYTES - 4096 {
            result.truncated = true;
            return;
        }
        *bytes += size + 1;
        let id = node.id.clone();
        result.nodes.push(node);
        let count = match api.child_count(&object) {
            Ok(count) => count,
            Err(_) => {
                result.unavailable_nodes += 1;
                return;
            }
        };
        if count > 1500 {
            result.truncated = true;
        }
        for i in 0..count.min(1500) {
            if result.nodes.len() >= 1500
                || clock() >= result.started_at + 3.0
                || *bytes >= MAX_BYTES - 4096
            {
                result.truncated = true;
                break;
            }
            match api.child(&object, i as u32) {
                Ok(child) => {
                    let mut path = path.clone();
                    path.push(i as u32);
                    walk(api, child, path, Some(id.clone()), clock, result, bytes);
                }
                Err(_) => result.unavailable_nodes += 1,
            }
        }
    }
    let root = api.desktop()?; // A missing bus/root is an error, never a successful empty desktop.
    walk(api, root, vec![], None, &clock, &mut result, &mut bytes);
    if result.nodes.is_empty() {
        return Err("native accessibility root unavailable".into());
    }
    Ok(result)
}

/// 42 is definite pre-invocation refusal. Any failure once invoke starts is 43 (uncertain).
pub fn perform(api: &impl Api, request: &ActionContext, clock: impl Fn() -> f64) -> i32 {
    let resolved = (|| -> Result<_> {
        let start = request.started_at;
        let end = request.expires_at;
        if !start.is_finite()
            || !end.is_finite()
            || start < 0.0
            || !(0.0 < end - start && end - start <= 15.0)
            || request.chain.is_empty()
            || request.chain.len() > 31
            || request.action.len() > 4096
        {
            return Err("invalid action context".into());
        }
        let fresh = || -> Result<()> {
            let now = clock();
            if !now.is_finite() || now < start || now >= end {
                return Err("expired action context".into());
            }
            Ok(())
        };
        fresh()?;
        let mut object = api.desktop()?;
        let mut seen = HashSet::new();
        for (i, node) in request.chain.iter().enumerate() {
            fresh()?;
            let parent = i.checked_sub(1).map(|p| &request.chain[p]);
            if !seen.insert(&node.id)
                || node.id.is_empty()
                || node.path.iter().any(|index| *index > i32::MAX as u32)
                || match parent {
                    None => !node.path.is_empty() || node.parent_id.is_some(),
                    Some(p) => {
                        node.parent_id.as_ref() != Some(&p.id)
                            || node.path.len() != p.path.len() + 1
                            || !node.path.starts_with(&p.path)
                    }
                }
            {
                return Err("incomplete or ambiguous parent path".into());
            }
            if i > 0 {
                object = api.child(&object, *node.path.last().ok_or("missing child path")?)?;
            }
            if api.describe(&object)? != node.details {
                return Err("native target context changed".into());
            }
        }
        if !request
            .chain
            .last()
            .unwrap()
            .details
            .actions
            .contains(&request.action)
        {
            return Err("action was not inspected".into());
        }
        let (action, actions) = api.actions(&object)?;
        let matches: Vec<_> = actions
            .iter()
            .enumerate()
            .filter(|(_, action)| **action == request.action)
            .map(|(i, _)| i)
            .collect();
        if matches.len() != 1 {
            return Err("unavailable or ambiguous action".into());
        }
        fresh()?;
        Ok((action, matches[0]))
    })();
    let (object, index) = match resolved {
        Ok(resolved) => resolved,
        Err(_) => return 42,
    };
    match api.invoke(&object, index) {
        Ok(true) => 0,
        _ => 43,
    }
}

/// Called only by an explicit guest-confirmed CLI mode; never by PID1 bootstrap.
pub fn run_worker(action: bool) -> i32 {
    let expected = if action {
        "--atspi-action"
    } else {
        "--atspi-inspect"
    };
    if std::env::args().skip(1).collect::<Vec<_>>() != [expected, "--guest-confirmed"] {
        return 42;
    }
    #[cfg(target_os = "linux")]
    {
        use std::io::{Read, Write};
        if unsafe { libc::geteuid() } == 0 || std::process::id() == 1 {
            return 42;
        }
        let clock = || crate::runtime::now() as f64 / 1000.0;
        if action {
            let mut input = Vec::new();
            if std::io::stdin()
                .take(MAX_BYTES as u64 + 1)
                .read_to_end(&mut input)
                .is_err()
                || input.len() > MAX_BYTES
            {
                return 42;
            }
            let request: ActionContext = match serde_json::from_slice(&input) {
                Ok(r) => r,
                Err(_) => return 42,
            };
            let api = match native::Native::load() {
                Ok(api) => api,
                Err(_) => return 42,
            };
            perform(&api, &request, clock)
        } else {
            let outcome = (|| -> Result<()> {
                let api = native::Native::load()?;
                let snapshot = capture(&api, clock)?;
                let bytes = serde_json::to_vec(&snapshot)?;
                if bytes.len() > MAX_BYTES {
                    return Err("snapshot envelope exceeded".into());
                }
                std::io::stdout().write_all(&bytes)?;
                Ok(())
            })();
            if outcome.is_ok() {
                0
            } else {
                42
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = action;
        42
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    struct Fixture {
        details: RefCell<Vec<Details>>,
        children: Vec<Vec<usize>>,
        calls: RefCell<Vec<usize>>,
        current: Cell<f64>,
        expire_on_actions: Cell<bool>,
        fail: Cell<bool>,
        posted: Cell<bool>,
    }
    impl Fixture {
        fn new() -> Self {
            let details = ["Desktop", "Documents", "Delete", "Status"]
                .into_iter()
                .map(|name| Details {
                    role: "button".into(),
                    name: name.into(),
                    identifier: name.into(),
                    states: vec!["enabled".into()],
                    actions: vec!["click".into()],
                    bounds: Some(Bounds {
                        x: 0,
                        y: 0,
                        width: 10,
                        height: 10,
                    }),
                    properties: BTreeMap::from([("description".into(), "Description".into())]),
                })
                .collect();
            Self {
                details: RefCell::new(details),
                children: vec![vec![1], vec![2, 3], vec![], vec![]],
                calls: RefCell::new(vec![]),
                current: Cell::new(100.0),
                expire_on_actions: Cell::new(false),
                fail: Cell::new(false),
                posted: Cell::new(true),
            }
        }
        fn context(&self) -> ActionContext {
            let snapshot = capture(self, || self.current.get()).unwrap();
            ActionContext {
                chain: snapshot.nodes.into_iter().take(3).collect(),
                action: "click".into(),
                started_at: 100.0,
                expires_at: 115.0,
            }
        }
        fn perform(&self, request: &ActionContext) -> i32 {
            perform(self, request, || self.current.get())
        }
    }
    impl Api for Fixture {
        type Handle = usize;
        fn desktop(&self) -> Result<usize> {
            Ok(0)
        }
        fn describe(&self, object: &usize) -> Result<Details> {
            Ok(self.details.borrow()[*object].clone())
        }
        fn child_count(&self, object: &usize) -> Result<usize> {
            Ok(self.children[*object].len())
        }
        fn child(&self, object: &usize, index: u32) -> Result<usize> {
            self.children[*object]
                .get(index as usize)
                .copied()
                .ok_or_else(|| "missing child".into())
        }
        fn actions(&self, object: &usize) -> Result<(usize, Vec<String>)> {
            if self.expire_on_actions.get() {
                self.current.set(115.0);
            }
            Ok((*object, self.details.borrow()[*object].actions.clone()))
        }
        fn invoke(&self, object: &usize, index: usize) -> Result<bool> {
            self.calls.borrow_mut().push(index);
            assert_eq!(*object, 2);
            if self.fail.get() {
                return Err("unknown native outcome".into());
            }
            Ok(self.posted.get())
        }
    }
    #[test]
    fn inspected_target_invokes_once_and_allows_unrelated_sibling_change() {
        let f = Fixture::new();
        let r = f.context();
        f.details.borrow_mut()[3].name = "Changed sibling".into();
        assert_eq!(f.perform(&r), 0);
        assert_eq!(*f.calls.borrow(), vec![0]);
    }
    #[test]
    fn changed_ancestors_and_targets_refuse_before_native_invocation() {
        for index in 0..3 {
            let f = Fixture::new();
            let r = f.context();
            f.details.borrow_mut()[index].name = "Changed context".into();
            assert_eq!(f.perform(&r), 42);
            assert!(f.calls.borrow().is_empty());
        }
    }
    #[test]
    fn duplicate_actions_and_incomplete_paths_refuse() {
        let f = Fixture::new();
        let mut r = f.context();
        r.chain.remove(0);
        assert_eq!(f.perform(&r), 42);
        let mut r = f.context();
        r.chain[2].parent_id = Some("wrong".into());
        assert_eq!(f.perform(&r), 42);
        let mut r = f.context();
        r.chain[2].id = r.chain[0].id.clone();
        assert_eq!(f.perform(&r), 42);
        let mut r = f.context();
        r.chain[1].path = vec![u32::MAX];
        assert_eq!(f.perform(&r), 42);
        let r = f.context();
        f.details.borrow_mut()[2].actions.push("click".into());
        assert_eq!(f.perform(&r), 42);
        assert!(f.calls.borrow().is_empty());
    }
    #[test]
    fn expiry_during_action_interface_lookup_is_checked_before_invoke() {
        let f = Fixture::new();
        let r = f.context();
        f.expire_on_actions.set(true);
        assert_eq!(f.perform(&r), 42);
        assert!(f.calls.borrow().is_empty());
    }
    #[test]
    fn expiry_rollback_nonfinite_and_excess_lifetimes_refuse() {
        for current in [99.0, 115.0, f64::NAN] {
            let f = Fixture::new();
            let r = f.context();
            f.current.set(current);
            assert_eq!(f.perform(&r), 42);
        }
        for end in [100.0, 116.0, f64::INFINITY] {
            let f = Fixture::new();
            let mut r = f.context();
            r.expires_at = end;
            assert_eq!(f.perform(&r), 42);
        }
    }
    #[test]
    fn false_and_error_after_invoke_are_unknown_not_refusal() {
        let f = Fixture::new();
        let r = f.context();
        f.posted.set(false);
        assert_eq!(f.perform(&r), 43);
        f.fail.set(true);
        assert_eq!(f.perform(&r), 43);
        assert_eq!(*f.calls.borrow(), vec![0, 0]);
    }
    #[test]
    fn snapshot_bounds_nodes_depth_and_output_bytes() {
        let mut f = Fixture::new();
        f.children = vec![vec![0]];
        let s = capture(&f, || 100.0).unwrap();
        assert!(s.truncated);
        assert_eq!(s.nodes.len(), 26);
        let mut f = Fixture::new();
        f.children = vec![vec![0; 2000]];
        let s = capture(&f, || 100.0).unwrap();
        assert!(s.truncated);
        assert!(s.nodes.len() <= 1500);
        let f = Fixture::new();
        f.details.borrow_mut()[0].name = "x".repeat(MAX_BYTES);
        assert!(capture(&f, || 100.0).is_err());
    }
    #[test]
    fn context_json_rejects_unknown_fields_nonfinite_and_boolean_indices() {
        let f = Fixture::new();
        let r = f.context();
        let mut value =
            serde_json::json!({"chain":r.chain,"action":"click","startedAt":100,"expiresAt":115});
        value["chain"][1]["path"] = serde_json::json!([false]);
        assert!(serde_json::from_value::<ActionContext>(value).is_err());
        let value = serde_json::json!({"chain":[],"action":"click","startedAt":100,"expiresAt":115,"extra":true});
        assert!(serde_json::from_value::<ActionContext>(value).is_err());
        assert!(serde_json::from_str::<ActionContext>(
            "{\"chain\":[],\"action\":\"click\",\"startedAt\":NaN,\"expiresAt\":115}"
        )
        .is_err());
    }
    #[test]
    fn native_numeric_values_survive_javascript_json_normalization() {
        let f = Fixture::new();
        f.details.borrow_mut()[2]
            .properties
            .insert("value".into(), serde_json::json!(0.0));
        let mut r = f.context();
        r.chain[2]
            .details
            .properties
            .insert("value".into(), serde_json::json!(0));
        assert_eq!(f.perform(&r), 0);
        r.chain[2]
            .details
            .properties
            .insert("value".into(), serde_json::json!(1));
        assert_eq!(f.perform(&r), 42);
    }
    #[test]
    fn non_linux_worker_refuses_without_loading_any_library() {
        #[cfg(not(target_os = "linux"))]
        {
            assert_eq!(run_worker(false), 42);
            assert_eq!(run_worker(true), 42);
        }
    }
}
