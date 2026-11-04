import { api, errorMessage } from "@/lib/api";
import { operationReceipt } from "./types";
const queues = new Map<string, Promise<Record<string, unknown>>>();
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
export function operate(
  machine: string,
  action: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const previous = queues.get(machine) || Promise.resolve();
  const task = previous
    .catch(() => {})
    .then(async () => {
      const id = crypto.randomUUID();
      let receipt;
      try {
        receipt = await api(
          `machines/${machine}/operations`,
          {
            id,
            action,
            arguments: args,
          },
          operationReceipt,
        );
      } catch (error) {
        throw new Error(
          `${errorMessage(error)} Operation ${id}; inspect this receipt before retrying.`,
        );
      }
      const until = Date.now() + 130000;
      while (receipt.state === "queued" && Date.now() < until) {
        await pause(250);
        receipt = await api(`operations/${id}`, undefined, operationReceipt);
      }
      if (receipt.state !== "succeeded")
        throw new Error(
          `${receipt.result?.detail || `Operation ${receipt.state}`}. Receipt ${id}.`,
        );
      return receipt.result || {};
    });
  queues.set(machine, task);
  task
    .finally(() => {
      if (queues.get(machine) === task) queues.delete(machine);
    })
    .catch(() => {});
  return task;
}
