import type { BackendId, Environment } from "./core.ts";
import { qualifiedPins } from "./qualified-pins.ts";

// One promoted exact pin and scope, generated from qualification/promotions.json
// at build time. See docs/runtime-qualification.md.
export interface QualifiedPin {
  backend: BackendId;
  os: "linux" | "macos";
  arch: "x86_64" | "aarch64";
  acceleration: string;
  executionMode: string;
  pinId: string;
  identity: Readonly<Record<string, unknown>>;
}

// The only scope each backend can report as qualified. Backends without a rule
// cannot qualify: Ollama lacks host isolation; vLLM and MLX-LM lack packages.
export const promotionRules: Readonly<Partial<Record<BackendId, { executionMode: string; acceleration: string }>>> = {
  "llama.cpp": { executionMode: "cpu-generation", acceleration: "cpu" },
  containerd: { executionMode: "root-lifecycle", acceleration: "none" },
  libvirt: { executionMode: "vm-boot", acceleration: "kvm" },
  "apple-virtualization": { executionMode: "vm-boot", acceleration: "vz" },
};

type Host = Pick<Environment, "platform" | "arch" | "qualifiedPins">;
const hostOs = (env: Host) => env.platform === "darwin" ? "macos" : env.platform === "linux" ? "linux" : undefined;
const hostArch = (env: Host) => env.arch === "arm64" ? "aarch64" : env.arch === "x64" ? "x86_64" : undefined;

// True only when the embedded table promotes this backend for the host's OS,
// architecture and the backend's single promotable scope, and the observed
// installation matches the promoted identity.
export function promoted(id: BackendId, env: Host, matches: (identity: Readonly<Record<string, unknown>>) => boolean): boolean {
  const rule = promotionRules[id];
  const os = hostOs(env), arch = hostArch(env);
  if (!rule || !os || !arch) return false;
  return (env.qualifiedPins ?? qualifiedPins).some(pin => pin.backend === id && pin.os === os && pin.arch === arch
    && pin.acceleration === rule.acceleration && pin.executionMode === rule.executionMode && matches(pin.identity));
}

export interface ReceiptAsset { name: string; version: string; sha256: string }
export function containerdPromoted(env: Host, assets: readonly ReceiptAsset[]): boolean {
  return promoted("containerd", env, identity => {
    const pinned = Array.isArray(identity.assets) ? identity.assets as ReceiptAsset[] : [];
    return pinned.length === assets.length && pinned.every(pin =>
      assets.some(asset => asset.name === pin.name && asset.version === pin.version && asset.sha256 === pin.sha256));
  });
}
