#![cfg(unix)]
use canaveral_kubevirt_execution::*;
struct NoRequests(Scope);
impl Api for NoRequests {
    fn scope(&self) -> &Scope {
        &self.0
    }
    fn request(
        &mut self,
        _: &str,
        _: &str,
        _: Option<&serde_json::Value>,
    ) -> Result<(u16, serde_json::Value)> {
        panic!("production create must not reach API")
    }
}
fn input() -> (Scope, Assignment, InstalledImage) {
    let id = "00000000-0000-4000-8000-000000000001".to_string();
    let image = Image {
        id: "linux".into(),
        revision: "1".into(),
        arch: "amd64".into(),
        backend: "kubevirt".into(),
        digest: format!("sha256:{}", "a".repeat(64)),
    };
    (
        Scope {
            namespace: "fixture".into(),
            service_account: "guest".into(),
            cluster_id: "https://fixture.invalid/".into(),
        },
        Assignment {
            id: id.clone(),
            claim_id: id.clone(),
            lease_id: id.clone(),
            member_id: id.clone(),
            domain_id: id.clone(),
            vm_id: id.clone(),
            binding: Binding {
                controller_id: id.clone(),
                runner_id: id.clone(),
                incarnation_id: id,
                generation: 1,
            },
            image: image.clone(),
            resources: Resources {
                cpu: 2,
                memory_mi_b: 4096,
                disk_gi_b: 20,
            },
            observed_revision: 1,
            expires_at: 200,
            controller_now: 100,
        },
        InstalledImage {
            image,
            snapshot: "base".into(),
            snapshot_uid: "snapshot-uid".into(),
            storage_class: "fixture".into(),
            disk_gib: 20,
        },
    )
}

#[test]
fn production_build_denies_create_on_resume_and_in_fresh_directory() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let (scope, assignment, image) = input();
    let unsupported = Error("production creation unsupported: reviewed cluster fence required");
    for name in ["original", "fresh-after-expiry-or-revocation"] {
        let path = root.join(name);
        let mut adapter = Adapter::prepare(
            &path,
            NoRequests(scope.clone()),
            MissingFence,
            scope.clone(),
            assignment.clone(),
            image.clone(),
        )
        .unwrap();
        assert_eq!(adapter.create("credential"), Err(Error(unsupported.0)));
        drop(adapter);
        let mut adapter = Adapter::resume(
            &path,
            NoRequests(scope.clone()),
            MissingFence,
            &scope,
            &assignment,
            &image,
        )
        .unwrap();
        assert_eq!(adapter.create("credential"), Err(Error(unsupported.0)));
    }
}
