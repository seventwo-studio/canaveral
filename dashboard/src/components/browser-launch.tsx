import { NativeSelect } from "./ui/native-select";
import { useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import type { Host } from "@/lib/infrastructure";
import { record } from "@/lib/types";
import { Button } from "./ui/button";

const engines = {
  chromium: "Chromium",
  firefox: "Firefox",
  webkit: "WebKit",
} as const;
type Engine = keyof typeof engines;

function browserReceipt(
  value: unknown,
  hostId: string,
  id: string,
  engine: Engine,
) {
  const r = record(value);
  if (
    r.id !== id ||
    r.engine !== engine ||
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
  const [engine, setEngine] = useState<Engine>("chromium");
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
              ? { id: browserId, engine, ttlSeconds: 300 }
              : undefined,
            (value) => browserReceipt(value, host.id, browserId, engine),
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
    <section aria-label="Browser session" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-0 flex-wrap items-center gap-2 text-ui font-medium">
          Browser engine
          <NativeSelect
            className="w-auto"
            value={engine}
            disabled={busy || Boolean(id)}
            onChange={(event) => setEngine(event.target.value as Engine)}
          >
            {Object.entries(engines).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </NativeSelect>
        </label>
        {eligible && !receipt && (
          <Button disabled={busy} onClick={() => run("launch")}>
            {id ? "Retry launch" : `Launch ${engines[engine]}`}
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
      {id && (
        <p className="text-xs text-muted-foreground">
          Browser ID <code className="break-all text-foreground">{id}</code>
        </p>
      )}
      {receipt && (
        <dl className="grid min-w-0 gap-x-4 gap-y-1 border-y py-3 text-ui sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-y-2 [&_dt]:text-muted-foreground [&_dd]:break-all">
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
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
    </section>
  );
}
