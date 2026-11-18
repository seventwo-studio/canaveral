# Private preview routing

## Lifecycle interface

The dashboard accepts a same-origin session-cookie POST to `/api/v1/previews/{id}/open` and returns `{handoffUrl}`. Each open creates a fresh isolated host. The handoff expires in 30 seconds. Its single redemption redirects to `/` with a 15-minute host-only Secure HttpOnly cookie.

Inside createDashboardServer, `previewLifecycle` is the optional
DashboardPreviews instance. Call `previewLifecycle?.target(ownerId, previewId)`
synchronously after authenticating the dashboard owner and again for each
private request. It returns undefined unless live, ready and owned, otherwise
`{ leaseId, operationId, leaseKey }` for server-internal dispatch to
`/v1/leases/{leaseId}/previews/{operationId}{target}` on the configured
controller origin. The gateway owns byte forwarding and the open route.

The gateway authenticates the original session using `GET /v1/auth/session` for issuance, redemption and each asset. It also inspects the scoped lease and checks its ID, ready state and expiry on each call. It sends only the lease bearer to the controller preview endpoint. The guest receives the method and root-relative target.

Asset requests share a FIFO queue keyed by lease ID and operation ID across all handoffs in one process. Each operation admits one active request and up to 24 waiters, subject to the listener’s overall limit of 32 concurrent requests. The gateway checks the original session, owner binding and lease when admitting the request, immediately before dispatch, and before sending bytes. Disconnected, expired and timed-out waiters lose their place. An asset has a 20-second queue and dispatch budget after admission. Controller dispatches already in flight retain their slot until they settle.

## Deployment example

Set `CANAVERAL_DASHBOARD_HOST=dashboard.example.com` and `CANAVERAL_PREVIEW_DOMAIN=preview.example.net` on one dashboard process. Point wildcard DNS and a wildcard TLS certificate at its HTTPS ingress. Use a separate registrable domain exclusively for previews. Proxy only the following hosts to the loopback dashboard listener, preserve Host, disable caching and omit request targets from access logs because the handoff path contains a one-use secret. Restarting the process invalidates all handoffs and preview cookies.

~~~nginx
server {
    listen 443 ssl;
    server_name dashboard.example.com *.preview.example.net;
    ssl_certificate /etc/nginx/tls/fullchain.pem;
    ssl_certificate_key /etc/nginx/tls/key.pem;
    access_log off;
    location / {
        proxy_set_header Host $host;
        proxy_pass http://127.0.0.1:8766;
    }
}
~~~
