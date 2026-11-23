import { ServiceError } from "./errors.ts";

export function kubernetesDeployment(config: Record<string, unknown>): boolean {
  if (config.deployment === undefined) {
    if (config.shutdownGraceSeconds !== undefined) throw new ServiceError("shutdownGraceSeconds requires Kubernetes deployment.", 400);
    return false;
  }
  if (config.deployment !== "kubernetes") throw new ServiceError("Invalid host deployment. Use kubernetes or omit deployment.", 400);
  const grace = config.shutdownGraceSeconds;
  if (grace !== undefined && (typeof grace !== "number" || !Number.isSafeInteger(grace) || grace < 1 || grace > 300)) {
    throw new ServiceError("Kubernetes shutdownGraceSeconds must be an integer from 1 to 300.", 400);
  }
  return true;
}

export const clusterContainerdCode = "kubernetes_containerd_disabled";

export function requireManagedUpdates(config: Record<string, unknown>): void {
  if (kubernetesDeployment(config)) {
    throw new ServiceError("Update Kubernetes hosts through their DaemonSet image.", 409, { code: "kubernetes_managed_updates_disabled" });
  }
}
