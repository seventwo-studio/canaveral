use super::*;
fn request(s: &Satellite) -> crate::reconcile::Request {
    let a = s.assignment().unwrap();
    serde_json::from_value(
        json!({"version":1,"mutationUUID":uuid::Uuid::from_u128(900),
        "binding":s.config.binding,"claimId":s.state.claim_id,"assignmentId":a.id,
        "leaseId":a.lease_id,"memberId":a.member_id,"domainId":a.domain_id,
        "imageDigest":a.image.digest,"bootAttempt":null}),
    )
    .unwrap()
}
fn held(c: &Config) -> Satellite {
    let mut s = seeded(c);
    s.state.launch_intent = true;
    s.state.worker_ownership_protocol = Some(1);
    s.dir.workspace().unwrap();
    std::fs::create_dir(s.machine().unwrap()).unwrap();
    std::fs::set_permissions(s.machine().unwrap(), std::fs::Permissions::from_mode(0o700)).unwrap();
    s.save().unwrap();
    s
}
#[test]
fn identities_legacy_and_active_lease_never_remove_storage() {
    let (_tmp, c) = fixture();
    let mut s = held(&c);
    let req = request(&s);
    let mut w = wire(s.assignment().unwrap().clone());
    for key in [
        "binding",
        "claimId",
        "assignmentId",
        "leaseId",
        "memberId",
        "domainId",
        "imageDigest",
        "bootAttempt",
    ] {
        let mut value = serde_json::to_value(&req).unwrap();
        if key == "binding" {
            value[key]["generation"] = json!(99);
        } else if key == "imageDigest" {
            value[key] = json!("sha256:changed");
        } else {
            value[key] = json!(uuid::Uuid::from_u128(999));
        }
        assert!(s
            .reconcile(&mut w, serde_json::from_value(value).unwrap())
            .is_err());
    }
    assert!(w.requests.is_empty());
    s.state.worker_ownership_protocol = None;
    assert!(s.reconcile(&mut w, req.clone()).is_err());
    assert!(w.requests.is_empty());
    s.state.worker_ownership_protocol = Some(1);
    assert_eq!(
        s.reconcile(&mut w, req),
        Err("reconciliation requires terminal controller intent")
    );
    assert!(!s.state.stopped && s.workspace().exists());
}
#[cfg(target_os = "macos")]
#[test]
fn reconciliation_releases_only_after_proof_and_replays_across_reset() {
    let (_tmp, c) = fixture();
    let mut s = held(&c);
    let req = request(&s);
    let mut w = wire(s.assignment().unwrap().clone());
    w.cancel = true;
    // Missing runtime.lock is created and held rather than treated as absence.
    let outcome = s.reconcile(&mut w, req.clone()).unwrap();
    assert!(s.state.stopped && s.state.cleaned && s.state.released);
    assert!(!s.workspace().exists());
    let count = w.requests.len();
    assert_eq!(s.reconcile(&mut w, req.clone()).unwrap(), outcome);
    assert_eq!(w.requests.len(), count);
    let mut changed = serde_json::to_value(&req).unwrap();
    changed["domainId"] = json!(uuid::Uuid::from_u128(333));
    assert_eq!(
        s.reconcile(&mut w, serde_json::from_value(changed).unwrap()),
        Err("reconciliation mutation conflicts")
    );
    // Simulate final reply/publication loss, then ordinary next-claim reset.
    let target = format!("reconciliation-{}.json", uuid::Uuid::from_u128(900));
    s.dir
        .write(
            &target,
            "state.next",
            &serde_json::to_vec(&json!({"request":req,"outcome":null})).unwrap(),
        )
        .unwrap();
    w.claim_null = true;
    s.run_once(&mut w).unwrap();
    assert_ne!(s.state.claim_id, w.a.claim_id);
    assert_eq!(s.reconcile(&mut w, req).unwrap(), outcome);
}
#[test]
fn launch_intent_before_workspace_creation_stays_held() {
    let (_tmp, c) = fixture();
    let mut s = seeded(&c);
    s.state.launch_intent = true;
    s.state.worker_ownership_protocol = Some(1);
    s.save().unwrap();
    let req = request(&s);
    let mut w = wire(s.assignment().unwrap().clone());
    w.cancel = true;
    assert_eq!(
        s.reconcile(&mut w, req),
        Err("workspace missing before deletion intent")
    );
    assert!(!s.state.stopped && !s.state.cleaned && !s.state.released);
}

#[test]
fn lost_reports_and_missing_storage_retain_exact_intent() {
    let (_tmp, c) = fixture();
    let mut s = held(&c);
    let req = request(&s);
    let mut w = wire(s.assignment().unwrap().clone());
    w.cancel = true;
    w.lose = true;
    assert!(s.reconcile(&mut w, req.clone()).is_err());
    let pending = s.state.pending.clone().unwrap();
    drop(s);
    let mut s = reopen_after_workers(c.clone());
    assert!(s.reconcile(&mut w, req.clone()).is_err());
    assert_eq!(s.state.pending.as_ref(), Some(&pending));
    std::fs::remove_dir_all(s.workspace()).unwrap();
    w.lose = false;
    assert_eq!(
        s.reconcile(&mut w, req.clone()),
        Err("workspace missing before deletion intent")
    );
    assert!(!s.state.stopped && !s.state.cleaned && !s.state.released);
    s.state.cleaning = true;
    s.save().unwrap();
    assert!(s.reconcile(&mut w, req).unwrap()["released"] == true);
}

#[cfg(target_os = "macos")]
#[test]
fn foreign_handle_and_lost_cleanup_reply_never_bypass_recovery() {
    struct LoseCleanup {
        wire: Wire,
        lose: bool,
    }
    impl Controller for LoseCleanup {
        fn request(&mut self, route: LeaseRoute, body: Value) -> Result<Value> {
            let response = self.wire.request(route, body.clone())?;
            if self.lose && body["receipt"]["cleanup"] == "complete" {
                self.lose = false;
                return Err("lost cleanup acknowledgment");
            }
            Ok(response)
        }
    }
    let (_tmp, c) = fixture();
    let mut s = held(&c);
    let req = request(&s);
    let path = s.machine().unwrap().join("disk.img");
    std::fs::write(&path, b"owned fixture").unwrap();
    let foreign = File::open(path).unwrap();
    let mut w = LoseCleanup {
        wire: wire(s.assignment().unwrap().clone()),
        lose: true,
    };
    w.wire.cancel = true;
    assert_eq!(
        s.reconcile(&mut w, req.clone()),
        Err("workspace handles unproven; reservation held")
    );
    assert!(!s.state.stopped && !s.state.cleaned);
    drop(foreign);
    assert_eq!(
        s.reconcile(&mut w, req.clone()),
        Err("lost cleanup acknowledgment")
    );
    let pending = s.state.pending.clone().unwrap();
    assert!(s.state.cleaned && !s.state.released);
    drop(s);
    let mut s = reopen_after_workers(c);
    s.run_once(&mut w).unwrap();
    assert!(s.state.released);
    assert!(
        w.wire
            .requests
            .iter()
            .filter(|(_, body)| *body == pending)
            .count()
            >= 2
    );
    // Simulate lost final publication; explicit replay must not send a new report
    // against the already closed assignment.
    let target = format!("reconciliation-{}.json", uuid::Uuid::from_u128(900));
    s.dir
        .write(
            &target,
            "state.next",
            &serde_json::to_vec(&json!({"request":req,"outcome":null})).unwrap(),
        )
        .unwrap();
    let count = w.wire.requests.len();
    assert!(s.reconcile(&mut w, req).unwrap()["released"] == true);
    assert_eq!(w.wire.requests.len(), count);
}
