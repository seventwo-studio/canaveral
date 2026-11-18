import { useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import type { Host } from "@/lib/infrastructure";
import { record } from "@/lib/types";
import { Button } from "./ui/button";

function browserReceipt(value: unknown, hostId: string, id: string) {
  const r = record(value);
  if (
    r.id !== id ||
    r.engine !== "chromium" ||
    typeof r.key !== "string" ||
    !r.key ||
    typeof r.endpoint !== "string" ||
    typeof r.expiresAt !== "string" ||
    !(Date.parse(r.expiresAt) > Date.now())
  )
    throw new Error("Invalid browser receipt.");
  const url = new URL(r.endpoint);
  if (
    url.protocol !== "wss:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== `/v1/hosts/${hostId}/browsers/${id}/connect`
  )
    throw new Error("Invalid browser endpoint.");
  return { endpoint: r.endpoint, key: r.key, expiresAt: r.expiresAt };
}

export function BrowserLaunch({ host }: { host: Host }) {
  const [id, setId] = useState("");
  const [receipt, setReceipt] = useState<ReturnType<
    typeof browserReceipt
  > | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const eligible =
    host.online &&
    host.enabled &&
    host.placementReady &&
    host.platform === "macos" &&
    host.runtimes?.includes("browser");
  useEffect(() => {
    if (!receipt) return;
    const timer = setTimeout(
      () => {
        setReceipt(null);
        setId("");
        setMessage("Browser access expired.");
      },
      Date.parse(receipt.expiresAt) - Date.now(),
    );
    return () => clearTimeout(timer);
  }, [receipt]);

  async function run(action: "launch" | "inspect" | "stop") {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const browserId = id || crypto.randomUUID();
      setId(browserId);
      const collection = `hosts/${host.id}/browsers`;
      const item = `${collection}/${browserId}`;
      if (action === "stop") {
        await api(
          item,
          undefined,
          (value) => {
            const r = record(value);
            if (r.id !== browserId || r.state !== "closed")
              throw new Error("Browser cleanup unconfirmed.");
          },
          "DELETE",
        );
        setId("");
        setReceipt(null);
        setMessage("Browser stopped.");
      } else {
        setReceipt(
          await api(
            action === "launch" ? collection : item,
            action === "launch"
              ? { id: browserId, engine: "chromium", ttlSeconds: 300 }
              : undefined,
            (value) => browserReceipt(value, host.id, browserId),
          ),
        );
      }
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  if (!eligible && !id) return null;
  return (
    <section aria-label="Chromium browser" className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {eligible && !receipt && (
          <Button disabled={busy} onClick={() => run("launch")}>
            {id ? "Retry launch" : "Launch Chromium"}
          </Button>
        )}
        {id && (
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => run("inspect")}
            >
              Inspect browser
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => run("stop")}
            >
              Stop browser
            </Button>
          </>
        )}
      </div>
      {id && <p className="break-all text-xs">Browser ID {id}</p>}
      {receipt && (
        <dl className="break-all text-sm">
          <dt>Playwright endpoint</dt>
          <dd>
            <code>{receipt.endpoint}</code>
          </dd>
          <dt>Scoped key</dt>
          <dd>
            <code>{receipt.key}</code>
          </dd>
          <dt>Expires</dt>
          <dd>
            <time dateTime={receipt.expiresAt}>{receipt.expiresAt}</time>
          </dd>
        </dl>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
