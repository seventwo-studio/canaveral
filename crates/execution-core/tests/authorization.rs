use canaveral_execution_core::authorization::{
    conservative_deadline, AuthorizationError, ExecutionScope, NativeAuthorization,
};
use serde_json::Value;

fn fixture() -> NativeAuthorization {
    let values: Vec<Value> = serde_json::from_str(include_str!(
        "../../../fixtures/migration/native-authorization.json"
    ))
    .unwrap();
    serde_json::from_value(values[0]["value"].clone()).unwrap()
}

#[test]
fn shared_coordination_execution_wire_cases() {
    let values: Vec<Value> = serde_json::from_str(include_str!(
        "../../../fixtures/migration/native-authorization.json"
    ))
    .unwrap();
    for case in values {
        let result = serde_json::from_value::<NativeAuthorization>(case["value"].clone())
            .map_err(|_| AuthorizationError::InvalidRecord)
            .and_then(|value| value.validate());
        assert_eq!(
            result.is_ok(),
            case["valid"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
    }
}

#[test]
fn renewals_cannot_extend_without_revision_or_revive_fenced_execution() {
    let initial = fixture();
    let mut later = initial.clone();
    later.deadline += 10.0;
    assert_eq!(
        later.clone().constrain(Some(&initial)).unwrap().deadline,
        initial.deadline
    );
    later.revision += 1;
    assert_eq!(
        later.clone().constrain(Some(&initial)).unwrap().deadline,
        later.deadline
    );
    let mut fenced = initial.clone();
    fenced.fenced = true;
    assert!(later.constrain(Some(&fenced)).unwrap().fenced);
    let mut older = initial.clone();
    older.revision = 0;
    assert!(older.constrain(Some(&initial)).is_err());
    let mut newer = initial.clone();
    newer.revision += 1;
    assert_eq!(
        initial.constrain(Some(&newer)),
        Err(AuthorizationError::RevisionRegressed)
    );
}

#[test]
fn changed_assignment_lease_launch_or_kernel_boot_is_never_adopted() {
    let initial = fixture();
    for field in 0..4 {
        let mut changed = initial.clone();
        match field {
            0 => changed.machine_id = uuid::Uuid::nil(),
            1 => changed.lease_id = uuid::Uuid::nil(),
            2 => changed.boot += 1.0,
            _ => changed.boot_session_id = uuid::Uuid::nil(),
        }
        assert_eq!(
            changed.constrain(Some(&initial)),
            Err(AuthorizationError::OwnershipChanged)
        );
    }
}

#[test]
fn execution_requires_current_scope_and_unexpired_continuous_clock() {
    let record = fixture();
    let mut scope = ExecutionScope {
        machine_id: record.machine_id,
        lease_id: record.lease_id,
        boot: record.boot,
        boot_session_id: record.boot_session_id,
    };
    assert!(record.permits(&scope, record.deadline - 0.001));
    for now in [
        record.deadline,
        record.deadline + 1.0,
        -1.0,
        f64::INFINITY,
        f64::NAN,
    ] {
        assert!(!record.permits(&scope, now));
    }
    scope.boot_session_id = uuid::Uuid::nil();
    assert!(!record.permits(&scope, 0.0));
    let mut fenced = record.clone();
    fenced.fenced = true;
    scope.boot_session_id = record.boot_session_id;
    assert!(!fenced.permits(&scope, 0.0));
}

#[test]
fn sampling_latency_and_publication_margin_are_always_deducted() {
    assert_eq!(conservative_deadline(500.0, 10.0, 1.0), Ok(508.75));
    assert_eq!(conservative_deadline(0.0, 0.0, 1.0), Ok(0.0));
    for bad in [-1.0, f64::INFINITY, f64::NAN] {
        assert!(conservative_deadline(bad, 10.0, 1.0).is_err());
        assert!(conservative_deadline(500.0, bad, 1.0).is_err());
        assert!(conservative_deadline(500.0, 10.0, bad).is_err());
    }
}
