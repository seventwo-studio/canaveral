# PID1 namespace preview evidence

On 2026-11-18 the namespace fixture passed on the aarch64 Lima instance
`canaveral-browser-pr55`. The build used the cached Rust toolchain offline.

```sh
cargo build --offline -p canaveral-guest-agent --bin canaveral-guest-agent --example namespace-supervision
CANAVERAL_NAMESPACE_FIXTURE=1 node fixtures/guest-agent/namespace.mjs
```

The host driver checked the launch binding and nonce in the dataReady reply.
After previewReady it sent a GET with a freshly generated query value. The
Node service echoed its UID, working directory and request target. After
confirmed cancellation the host repeated the GET with a fresh request ID.
The response payload was empty and a new listener on the old port received
no connection.

```text
previewReady 39433, authenticated GET 200 1000 /workspace /fixture?nonce=33b53dea-9752-4674-b75c-583236840ab9, cancel confirmed, post-stop GET denied without connecting to rebound port
production namespace supervision fixture passed
```

The fixture ran as PID1 in isolated PID, mount and network namespaces with
Unix socket pairs for control and data. Full Canaveral guest boot, virtio-vsock
and Apple satellite integration remain unverified by this run. Lima reported
the instance stopped after shutdown.
