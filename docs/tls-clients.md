# Verified TLS clients

The TypeScript HTTP and session SDK uses `caFile` for a controller served over
HTTPS. The PEM bundle replaces that client's default trust store. Omit it to use
Node's default trust store. Chain and hostname verification remain enabled for
HTTP and outbound WebSocket connections.

```ts
import { ConsumerClient, LeaseClient } from "../coordination/src/sdk.ts";

const consumer = ConsumerClient.fromCredentialFile({
  baseUrl: "https://compute.example", credentialFile: applicationKeyPath, caFile,
});
const lease = LeaseClient.fromCredentialFile({
  baseUrl: "https://compute.example", leaseId, credentialFile: leaseKeyPath, caFile,
});
```

These file loaders require a private, owned regular credential file on POSIX.
Loading an existing lease key never rotates it. `scopedLease(leaseId)` is a separate,
explicit credential rotation and can revoke other scoped clients. Validate trust
and persist the request intent before dispatch; do not print returned secrets.

`ca` accepts PEM contents as an alternative to `caFile`. Passing both is refused.
Trust loads during construction; recreate the client to load a changed bundle.
Missing or malformed bundles are configuration errors. A CA bundle with an HTTP
origin is refused. The option does not install system trust, discover an authority,
disable verification or enroll a host.

HTTPS uses TLS 1.2 or later. The SDK permits plaintext only with
`allowLoopbackHttp: true` and an IP-literal loopback host. It follows no redirects,
ignores environment proxies and sends credentials only as bearer headers. URLs
with userinfo, query or fragments are rejected. TLS failures after dispatch leave
mutation outcomes unknown; a certificate failure before request bytes does not
establish a controller mutation.

## Host startup

The TypeScript host must use verified controller trust for enrollment, heartbeat
and outbound session connections. Check the installed CLI before choosing its
configuration flags:

```sh
node coordination/dist/src/cli.js host --help
```

Supply the private CA bundle through the supported host option or configuration.
Backend-specific trust, such as Kubernetes API certificates, remains separate.
A trust failure must not create a new identity or switch to plaintext. A saved
identity is reused only for the same controller and binding. Trust configuration
grants no enrollment approval and no consumer lease eligibility.

The Rust runner client has its own documented trust semantics: see
[runner-client](../crates/runner-client/README.md). Do not assume its optional
root bundle and the TypeScript SDK's replacement trust store are interchangeable.

## Verification and live gates

Portable transport checks use disposable loopback servers and test certificates.
They must reject unrelated CAs, wrong hostnames and redirects before forwarding
credentials, and preserve mutation uncertainty after dropped or incomplete replies.
SDK checks do not establish separate-network reachability, reverse-proxy setup,
certificate lifecycle operations, firewall behavior or native provider acceptance.
Those remain operator acceptance work. No system trust store or running host is
changed by constructing an SDK client.
