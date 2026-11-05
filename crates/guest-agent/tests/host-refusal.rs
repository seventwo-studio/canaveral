#[test]
fn production_binary_refuses_host_and_stdio_escape() {
    let result = std::process::Command::new(env!("CARGO_BIN_EXE_canaveral-guest-agent"))
        .arg("--stdio-hostexec")
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("requires Linux PID1"));
}
