# Verified TLS clients

The Python SDK accepts an optional `ca_file` for a controller served over HTTPS.
The supplied PEM CA bundle configures that client's certificate trust. Omit it
to use Python's default trust store. Certificate-chain and hostname verification
remain enabled for both HTTP requests and outbound WebSocket connections.

```python
consumer = ConsumerClient.from_credential_file(
    'https://compute.example', application_key_path, ca_file=controller_ca_path,
)
lease = LeaseClient.from_credential_file(
    'https://compute.example', lease_id, lease_key_path, ca_file=controller_ca_path,
)
```

`ConsumerClient`, `LeaseClient` and `canaveral.client.Client` accept this keyword.
The existing-credential file factories retain it, as does application-to-lease
credential exchange. The lifecycle, display, accessibility and download examples
accept `--ca-file`. Existing lease-key loading does not rotate credentials.

The HTTP opener and session transport use the client's loaded SSL context, so
the same trust configuration applies to inventory, lifecycle and streamed
access. Contexts load during construction, not on every frame. Recreate a client
to load a changed bundle. Local CA setup is checked before the application SDK
rotates a lease key. Missing or malformed bundles are configuration errors; a
CA file with an HTTP origin is refused rather than silently ignored.

This option is useful across Python SSL implementations. For example, Python's
LibreSSL support [does not honor `SSL_CERT_FILE` or `SSL_CERT_PATH`](https://docs.python.org/3.9/library/ssl.html#libressl-support).
An explicit CA file avoids relying on those environment variables. It does not
install a certificate into system trust, discover an authority, disable
verification or enroll a host. Obtain the bundle through the operator's existing
setup process; this feature establishes no new enrollment or approval policy.

## Host startup

The host command also accepts `--ca-file` with either `--config` or `--setup-file`:

```sh
canaveral host --setup-file ./connection.json --state ./runner-state \
  --ca-file ./controller-ca.pem
```

For a configuration file, select the controller origin with the existing global
`--url` option before `host`. Library callers can pass `ca_file` to `Agent`.
Enrollment, authenticated heartbeats and outbound sessions use the configured
controller trust. Backend-specific trust, such as Kubernetes API certificates,
remains separate. This is a host subcommand option, not a new global CLI flag.

The path is supplied on startup and is not added to the downloaded setup JSON,
host offer or saved identity. Supply it again when restarting a host that needs
the private CA. Connecting validates local trust before persisting a new identity;
an invalid bundle creates no enrollment request. An unsuccessful remote attempt
retains its private identity so a corrected configuration can retry that same
host. Reconnecting a saved identity without an enrollment token does not enroll
another host. Offline `host --check` remains a backend environment check, not a
controller TLS handshake or enrollment proof.

Supplying a CA file grants no enrollment or host-approval permission. Ordinary
runners still cannot advertise consumer lease execution. The embedded production
HTTP service still expects operator TLS termination for remote use. No listener,
system trust store or running host configuration changes automatically.

## Fixture evidence and live gates

Temporary tests generate private test certificates, wrap disposable loopback
controller listeners in TLS and connect the real consumer and runner transports.
They exercise catalogue/lease reads, scoped credential exchange, PTY input/output,
upload, verified local download, native-shaped accessibility and synthetic RFB
capture/input/receipt recovery. Both sides of every tested session use SSL
sockets. Separate checks reject an unrelated CA and a trusted certificate with
the wrong hostname before API inspection or attachment is admitted. HTTP and
WebSocket clients refuse redirects rather than forwarding credentials elsewhere.

The fixtures use no system trust installation, actual simulator, native VM or
retained data. They prove encrypted loopback interoperability on the tested
Python runtime. They do not establish separate-network reachability, outbound-only
firewall behavior, a reverse-proxy deployment, certificate lifecycle operations,
native provider acceptance or platform-wide portability. Those gates remain
in the verification checkpoint.

Host CLI fixtures also cover both configuration entry points, private-identity
reuse, bad-bundle preflight and retries after untrusted-peer failure.
