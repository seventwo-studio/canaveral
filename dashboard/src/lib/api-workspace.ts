export interface ApiAction {
  id: string;
  feature: string;
  label: string;
  path: string;
  method: "GET" | "POST";
  identifier?: "UUID" | "SHA-256";
  help: string;
  secondIdentifier?: boolean;
  example?: () => Record<string, unknown>;
  recovery?: string;
}
const uuid = () => crypto.randomUUID();
const resources = { cpu: 2, memoryMiB: 2048, diskGiB: 20 };
const digest = `sha256:${"0".repeat(64)}`;
const binding = () => ({
  controllerId: uuid(),
  runnerId: uuid(),
  generation: 1,
  incarnationId: uuid(),
});
const grant = () => ({
  applicationId: uuid(),
  model: "model:latest",
  digest,
  maxUnfinished: 1,
});
const linuxGrant = () => ({
  applicationId: uuid(),
  imageId: "linux",
  revision: "1",
  arch: "arm64",
  digest,
});
function action(
  feature: string,
  id: string,
  label: string,
  path: string,
  method: "GET" | "POST",
  help: string,
  example?: ApiAction["example"],
  identifier?: ApiAction["identifier"],
  recovery?: string,
): ApiAction {
  return {
    feature,
    id,
    label,
    path,
    method,
    help,
    example,
    identifier,
    recovery,
  };
}
export const apiActions: readonly ApiAction[] = [
  action(
    "Configuration",
    "configuration-list",
    "Inspect configuration",
    "admin/configuration",
    "GET",
    "Read configured models, resource domains, permissions, runner bindings and artifact metadata without credentials.",
  ),
  action(
    "Applications",
    "applications-list",
    "List applications",
    "consumers",
    "GET",
    "Application image permissions, quotas and revocation state.",
  ),
  action(
    "Applications",
    "applications-create",
    "Create application",
    "consumers",
    "POST",
    "Replace example identifiers and image permissions with installed revisions. The credential is shown once.",
    () => ({
      id: uuid(),
      name: "Application",
      templates: [],
      limits: { resources, activeLeases: 1 },
    }),
    undefined,
    "If the reply is lost, list applications and inspect this ID, then rotate its credential. Creation is not replayable.",
  ),
  action(
    "Applications",
    "applications-rotate",
    "Rotate application credential",
    "consumers/{id}/credential",
    "POST",
    "Immediately replaces the application credential. Existing consumers must receive the replacement.",
    () => ({}),
    "UUID",
    "If the reply is lost, another explicit rotation creates a different credential. Inspect application state before proceeding.",
  ),
  action(
    "Applications",
    "applications-revoke",
    "Revoke application",
    "consumers/{id}/revoke",
    "POST",
    "Revokes application authorization and cancels waiting requests. This does not prove running guests have stopped.",
    () => ({}),
    "UUID",
  ),
  action(
    "Models",
    "model-catalog",
    "Register model",
    "model-catalog",
    "POST",
    "Pin an installed model label, supported adapter and exact SHA-256 digest.",
    () => ({ model: "model:latest", digest, adapter: "ollama", resources }),
  ),
  action(
    "Models",
    "model-grant",
    "Grant model access",
    "model-grants",
    "POST",
    "Grant an active application access to the exact catalogued model.",
    grant,
  ),
  action(
    "Models",
    "model-revoke",
    "Revoke model access",
    "model-grants/revoke",
    "POST",
    "Revoke the matching model grant.",
    () => {
      const { maxUnfinished: _, ...rest } = grant();
      return rest;
    },
  ),
  action(
    "Models",
    "model-approve",
    "Approve model runner",
    "model-runner-approvals",
    "POST",
    "Use the current enrolled runner binding and resource domain.",
    () => ({
      binding: binding(),
      domainId: uuid(),
      models: [{ model: "model:latest", digest }],
    }),
  ),
  action(
    "Models",
    "model-approval-revoke",
    "Revoke model runner approval",
    "model-runner-approvals/revoke",
    "POST",
    "Remove model execution approval for the exact runner binding.",
    () => ({ binding: binding() }),
  ),
  action(
    "Resource domains",
    "domain-create",
    "Define resource domain",
    "resource-domains",
    "POST",
    "Definitions are immutable. Repeating the identical definition is safe.",
    () => ({ id: uuid(), name: "Resource domain", capacity: resources }),
  ),
  action(
    "Resource domains",
    "domain-inspect",
    "Inspect resource domain",
    "resource-domains/{id}",
    "GET",
    "Show domain capacity and reservations.",
    undefined,
    "UUID",
  ),
  action(
    "Linux leases",
    "linux-image",
    "Register Linux image",
    "linux-lease-images",
    "POST",
    "Register an installed headless Linux image. Replace the example digest with verified artifact identity.",
    () => ({
      id: "linux",
      revision: "1",
      arch: "arm64",
      os: "linux",
      mode: "headless",
      backend: "appleVirtualization",
      digest,
      resources,
      capabilities: ["command", "pty", "files"],
    }),
  ),
  action(
    "Linux leases",
    "linux-grant",
    "Grant Linux image access",
    "linux-lease-grants",
    "POST",
    "Grant an application the exact image revision and digest.",
    linuxGrant,
  ),
  action(
    "Linux leases",
    "linux-grant-revoke",
    "Revoke Linux image access",
    "linux-lease-grants/revoke",
    "POST",
    "Revoke the exact image grant.",
    linuxGrant,
  ),
  action(
    "Linux leases",
    "linux-approve",
    "Approve Linux runner",
    "linux-lease-runner-approvals",
    "POST",
    "Use the enrolled binding and existing domain; approval does not establish native acceptance.",
    () => ({
      binding: binding(),
      domainId: uuid(),
      backend: "appleVirtualization",
      images: [{ id: "linux", revision: "1", arch: "arm64", digest }],
    }),
  ),
  action(
    "Linux leases",
    "linux-approval-revoke",
    "Revoke Linux runner approval",
    "linux-lease-runner-approvals/revoke",
    "POST",
    "Remove Linux execution approval for the exact runner binding.",
    () => ({ binding: binding() }),
  ),
  action(
    "Runner enrollment",
    "enrollment-issue",
    "Issue runner enrollment",
    "runner-enrollments",
    "POST",
    "Approve an explicit runner binding for up to 1800 seconds. The enrollment token is shown once.",
    () => ({ id: uuid(), ...binding(), ttlSeconds: 1800 }),
    undefined,
    "If the reply is lost, inspect this enrollment ID and revoke it before issuing a new ID. Issuing is not replayable.",
  ),
  action(
    "Runner enrollment",
    "enrollment-inspect",
    "Inspect runner enrollment",
    "runner-enrollments/{id}",
    "GET",
    "Show approval binding, expiry and consumption state without credentials.",
    undefined,
    "UUID",
  ),
  action(
    "Runner enrollment",
    "enrollment-revoke",
    "Revoke runner enrollment",
    "runner-enrollments/{id}/revoke",
    "POST",
    "Revokes enrollment approval and its consume replay permission.",
    () => ({}),
    "UUID",
  ),
  action(
    "Runner enrollment",
    "runner-credential",
    "Rotate runner credential",
    "runners/credential",
    "POST",
    "Use the current binding and advance credentialRevision by exactly one. Securely save the new credential and deliver it to the runner before applying.",
    () => ({
      ...binding(),
      credentialRevision: 2,
      credential: btoa(
        String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
      )
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", ""),
    }),
    undefined,
    "After a lost reply, retry only the exact revision and saved replacement credential. Rotation does not reactivate a revoked runner.",
  ),
  action(
    "Runner enrollment",
    "runner-revoke",
    "Revoke runner binding",
    "runners/revoke",
    "POST",
    "Fence the exact runner identity. Revocation does not prove execution has stopped or free reservations.",
    binding,
  ),
  action(
    "Machine operations",
    "operation-submit",
    "Submit machine operation",
    "machines/{id}/operations",
    "POST",
    "Install an uploaded application with this example. Other supported actions include apps, logs, screenshot, hierarchy, accessibility, tap, swipe, text, key, install, uninstall, launch, terminate, open-url, location, push, pull, list-files, shell, permission, rotate, accessibility-action and shell-open/read/write/close/resize. Arguments must match the selected action and platform capabilities.",
    () => ({
      id: uuid(),
      action: "install-uploaded",
      arguments: { artifact: uuid() },
    }),
    "UUID",
  ),
  action(
    "Machine operations",
    "operation-inspect",
    "Inspect machine operation",
    "operations/{id}",
    "GET",
    "Read the durable operation receipt, output and uncertain execution state. Do not replay uncertain effects under a new ID.",
    undefined,
    "UUID",
  ),
  action(
    "Managed updates",
    "releases-list",
    "List update releases",
    "updates/releases",
    "GET",
    "Registered signed release manifests.",
  ),
  action(
    "Managed updates",
    "release-inspect",
    "Inspect update release",
    "updates/releases/{id}",
    "GET",
    "Inspect a signed release by its release ID.",
    undefined,
    "UUID",
  ),
  action(
    "Managed updates",
    "release-register",
    "Register signed update release",
    "updates/releases",
    "POST",
    "Paste the complete signed release produced by your release tooling. The example signature is a placeholder. The configured trust keys must verify your signed envelope.",
    () => ({
      manifest: {
        schema: "canaveral-update-v1",
        releaseId: uuid(),
        version: "1.0.0",
        sequence: 1,
        createdAt: Math.floor(Date.now() / 1000),
        target: { os: "linux", arch: "amd64" },
        minimumLauncherVersion: 1,
        entrypoint: "host.js",
        files: [
          {
            path: "host.js",
            sha256: "0".repeat(64),
            bytes: 1,
            executable: false,
            component: "host",
          },
        ],
      },
      keyId: "replace-with-trusted-key-id",
      signature: "A".repeat(86) + "==",
    }),
  ),
  action(
    "Managed updates",
    "rollouts-list",
    "List update rollouts",
    "updates/rollouts",
    "GET",
    "Delivery, activation, component receipts and uncertain outcomes.",
  ),
  action(
    "Managed updates",
    "rollout-inspect",
    "Inspect update rollout",
    "updates/rollouts/{id}",
    "GET",
    "Inspect a rollout and its target jobs.",
    undefined,
    "UUID",
  ),
  action(
    "Managed updates",
    "rollout-create",
    "Create update rollout",
    "updates/rollouts",
    "POST",
    "Targets must already be registered and release artifacts verified. Scheduling drains affected hosts.",
    () => ({ id: uuid(), releaseId: uuid(), hostIds: [uuid()], runnerIds: [] }),
  ),
  action(
    "Managed updates",
    "rollout-cancel",
    "Cancel update rollout",
    "updates/rollouts/{id}/cancel",
    "POST",
    "Cancellation is allowed only before jobs have been delivered. A delivered job requires a positive host receipt.",
    () => ({}),
    "UUID",
  ),
  action(
    "Inference",
    "inference-models",
    "List inference models",
    "models",
    "GET",
    "Installed generation models and host readiness.",
  ),
  action(
    "Inference",
    "inference-jobs",
    "List inference jobs",
    "jobs",
    "GET",
    "Inspect generation state, output and cancellation.",
  ),
  action(
    "Inference",
    "inference-submit",
    "Submit inference job",
    "jobs",
    "POST",
    "Choose an advertised model and digest. The request ID remains unchanged on retry.",
    () => ({
      id: uuid(),
      model: "model:latest",
      digest,
      prompt: "Hello",
      maxTokens: 128,
    }),
  ),
  action(
    "Inference",
    "inference-inspect",
    "Inspect inference job",
    "jobs/{id}",
    "GET",
    "Read generation state and output.",
    undefined,
    "UUID",
  ),
  action(
    "Inference",
    "inference-cancel",
    "Cancel inference job",
    "jobs/{id}/cancel",
    "POST",
    "Request cancellation; reservations remain held until execution has positively stopped.",
    () => ({}),
    "UUID",
  ),
  action(
    "Application artifacts",
    "artifact-create",
    "Create application artifact",
    "machines/{id}/app-artifacts",
    "POST",
    "Reserve an upload for an owned mobile machine. Use apk or ios-app-tar as appropriate.",
    () => ({ id: uuid(), format: "apk", bytes: 1, sha256: "0".repeat(64) }),
    "UUID",
  ),
  action(
    "Application artifacts",
    "artifact-inspect",
    "Inspect application artifact",
    "app-artifacts/{id}",
    "GET",
    "Read received bytes, readiness and maximum chunk size.",
    undefined,
    "UUID",
  ),
  action(
    "Application artifacts",
    "artifact-chunk",
    "Upload application artifact chunk",
    "app-artifacts/{id}/chunks",
    "POST",
    "Paste base64 bytes at the next offset. Full decoded chunks must be 512 KiB (524288 bytes), matching advertised chunkBytes; the final chunk contains the remaining bytes.",
    () => ({ offset: 0, data: "AA==" }),
    "UUID",
  ),
  action(
    "Application artifacts",
    "artifact-complete",
    "Complete application artifact",
    "app-artifacts/{id}/complete",
    "POST",
    "Verify all received bytes against the declared size and SHA-256.",
    () => ({}),
    "UUID",
  ),
  action(
    "Application artifacts",
    "artifact-delete",
    "Delete application artifact",
    "app-artifacts/{id}/delete",
    "POST",
    "Erase uploaded chunks after any native staging cleanup is confirmed.",
    () => ({}),
    "UUID",
  ),
  action(
    "Managed updates",
    "update-chunk",
    "Upload update artifact chunk",
    "updates/artifacts/{id}",
    "POST",
    "Enter the artifact SHA-256 as lowercase hex and paste a base64 chunk of at most 512 KiB (524288 decoded bytes). The final upload verifies its digest.",
    () => ({ offset: 0, totalBytes: 1, data: "AA==" }),
    "SHA-256",
  ),
  action(
    "Mobile video",
    "video-create",
    "Create video session",
    "machines/{id}/video-sessions",
    "POST",
    "Negotiate a bounded 30 fps mobile video session. This workspace manages admission and closure; viewing requires a negotiated stream client.",
    () => ({ id: uuid(), fps: 30, durationSeconds: 60, bitRate: 2000000 }),
    "UUID",
  ),
  {
    ...action(
      "Mobile video",
      "video-inspect",
      "Inspect video session",
      "machines/{id}/video-sessions/{session}",
      "GET",
      "Inspect session admission and cleanup.",
      undefined,
      "UUID",
    ),
    secondIdentifier: true,
  },
  {
    ...action(
      "Mobile video",
      "video-close",
      "Close video session",
      "machines/{id}/video-sessions/{session}/close",
      "POST",
      "Disconnect this session. Cleanup remains pending until positively acknowledged.",
      () => ({}),
      "UUID",
    ),
    secondIdentifier: true,
  },
];
export function actionPath(
  action: ApiAction,
  identifier: string,
  secondIdentifier = "",
): string {
  if (!action.identifier) return action.path;
  const value = identifier.trim();
  const valid =
    action.identifier === "UUID"
      ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          value,
        )
      : /^[0-9a-f]{64}$/.test(value);
  if (!valid) throw new Error(`Enter a valid ${action.identifier} identifier.`);
  if (
    action.secondIdentifier &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      secondIdentifier.trim(),
    )
  )
    throw new Error("Enter a valid session UUID identifier.");
  return action.path
    .replace("{id}", value)
    .replace("{session}", secondIdentifier.trim());
}
export function actionBody(source: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("Configuration must be valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Configuration must be a JSON object.");
  return value as Record<string, unknown>;
}
