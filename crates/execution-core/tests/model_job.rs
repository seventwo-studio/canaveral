use canaveral_execution_core::model_job::ModelJob;
use serde_json::{json, Value};
fn corpus() -> Value {
    serde_json::from_str(include_str!("../../../fixtures/migration/model-job.json")).unwrap()
}
#[test]
fn shared_validation_ownership_and_release_cases() {
    for case in corpus()["cases"].as_array().unwrap() {
        let parsed = serde_json::from_value::<ModelJob>(case["value"].clone());
        assert_eq!(
            parsed.is_ok(),
            case["valid"].as_bool().unwrap(),
            "{}: {:?}",
            case["name"],
            parsed
        );
        if let Ok(job) = parsed {
            assert_eq!(
                job.can_release(),
                case["canRelease"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
            assert!(job.owns(&job.application_id));
            assert!(!job.owns("33333333-3333-4333-8333-333333333333"));
            let roundtrip: ModelJob =
                serde_json::from_value(serde_json::to_value(&job).unwrap()).unwrap();
            assert_eq!(job, roundtrip);
        }
    }
}
#[test]
fn shared_idempotency_conflicts() {
    for c in corpus()["comparisons"].as_array().unwrap() {
        let left: ModelJob = serde_json::from_value(c["left"].clone()).unwrap();
        let right = serde_json::from_value(c["right"].clone()).unwrap();
        assert_eq!(
            left.same_submission(&right),
            c["same"].as_bool().unwrap(),
            "{}",
            c["name"]
        );
    }
}
#[test]
fn utf8_byte_limit() {
    let mut value = corpus()["cases"][0]["value"].clone();
    value["message"]["prompt"] = json!("é".repeat(32768));
    assert!(serde_json::from_value::<ModelJob>(value.clone()).is_ok());
    value["message"]["prompt"] = json!(format!("{}x", "é".repeat(32768)));
    assert!(serde_json::from_value::<ModelJob>(value).is_err());
}

#[test]
fn shared_receipt_bindings() {
    for c in corpus()["bindings"].as_array().unwrap() {
        let submission: ModelJob = serde_json::from_value(c["submission"].clone()).unwrap();
        let receipt = serde_json::from_value(c["receipt"].clone()).unwrap();
        assert_eq!(
            submission.receipt_matches(&receipt),
            c["matches"].as_bool().unwrap(),
            "{}",
            c["name"]
        );
    }
}
#[test]
fn result_utf8_limit() {
    let data = corpus();
    let mut value = data["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "succeeded fully cleaned")
        .unwrap()["value"]
        .clone();
    value["message"]["result"]["text"] = json!("é".repeat(65536));
    assert!(serde_json::from_value::<ModelJob>(value.clone()).is_ok());
    value["message"]["result"]["text"] = json!(format!("{}x", "é".repeat(65536)));
    assert!(serde_json::from_value::<ModelJob>(value).is_err());
}

#[test]
fn shared_json_numeric_spellings() {
    let data = corpus();
    for c in data["numberSpellings"].as_array().unwrap() {
        let mut value = data["cases"][0]["value"].clone();
        value["message"]["maxTokens"] = json!("NUMBER");
        let encoded = serde_json::to_string(&value)
            .unwrap()
            .replace("\"NUMBER\"", c["wire"].as_str().unwrap());
        assert_eq!(
            serde_json::from_str::<ModelJob>(&encoded).is_ok(),
            c["valid"].as_bool().unwrap(),
            "{}",
            c["wire"]
        );
    }
}
