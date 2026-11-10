fn main() {
    println!("cargo:rerun-if-changed=../model-execution/src/socket_owner.c");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("../model-execution/src/socket_owner.c")
            .warnings_into_errors(true)
            .compile("mobile_socket_owner");
    }
}
