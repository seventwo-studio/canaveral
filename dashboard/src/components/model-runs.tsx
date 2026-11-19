import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { record } from "@/lib/types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const terminal = ["succeeded", "failed", "cancelled"];
const states = [
  "queued",
  "waitingForResources",
  "running",
  "unknown",
  ...terminal,
];
const stateLabels: Record<string, string> = {
  queued: "Queued",
  waitingForResources: "Waiting for resources",
  running: "Running",
  unknown: "Outcome unknown",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function modelOffer(value: unknown) {
  const { id, digest, hostId, online, accepting } = record(value);
  if (
    typeof id !== "string" ||
    !id ||
    typeof digest !== "string" ||
    !DIGEST.test(digest) ||
    typeof hostId !== "string" ||
    typeof online !== "boolean" ||
    typeof accepting !== "boolean"
  )
    throw Error("Invalid model offer.");
  return { id, digest, hostId, online, accepting };
}
export function modelJob(value: unknown, expected?: string) {
  const {
    id,
    hostId,
    model,
    definition,
    desired,
    state,
    detail,
    reservationHeld,
    stopped,
    cleanup,
    result,
  } = record(value);
  const digest = record(definition).digest;
  if (
    typeof id !== "string" ||
    !UUID.test(id) ||
    (expected !== undefined && id !== expected) ||
    typeof hostId !== "string" ||
    typeof model !== "string" ||
    typeof digest !== "string" ||
    typeof state !== "string" ||
    !states.includes(state) ||
    !["running", "cancelled"].includes(String(desired)) ||
    typeof reservationHeld !== "boolean" ||
    typeof stopped !== "boolean" ||
    !["pending", "complete"].includes(String(cleanup))
  )
    throw Error("Invalid model job response.");
  let output:
    { text: string; inputTokens: number; outputTokens: number } | undefined;
  if (result !== undefined) {
    const { text, usage } = record(result);
    const { inputTokens, outputTokens } = record(usage);
    if (
      state !== "succeeded" ||
      typeof text !== "string" ||
      !count(inputTokens) ||
      !count(outputTokens)
    )
      throw Error("Invalid model job result.");
    output = {
      text,
      inputTokens: inputTokens as number,
      outputTokens: outputTokens as number,
    };
  }
  return {
    id,
    hostId,
    model,
    digest,
    state,
    detail: typeof detail === "string" ? detail : "",
    cancelRequested: desired === "cancelled",
    reservationHeld,
    stopped,
    cleanup: cleanup as "pending" | "complete",
    output,
  };
}
type Offer = ReturnType<typeof modelOffer>;
type Job = ReturnType<typeof modelJob>;
type Submission = {
  id: string;
  model: string;
  digest: string;
  prompt: string;
  maxTokens: number;
};
const denied = (e: unknown) =>
  e instanceof Error && "status" in e && (e.status === 401 || e.status === 403);
const short = (digest: string) => digest.slice(0, 19);
const key = (o: { id: string; digest: string }) =>
  JSON.stringify([o.id, o.digest]);

function JobRow({
  initial,
  follow,
  onDenied,
}: {
  initial: Job;
  follow: boolean;
  onDenied: () => void;
}) {
  const [row, setRow] = useState(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [inspect, setInspect] = useState(
    follow || !terminal.includes(initial.state) || initial.reservationHeld,
  );
  const [refresh, setRefresh] = useState(0);
  const deniedCallback = useRef(onDenied);
  deniedCallback.current = onDenied;
  // A list refresh omits result bodies; keep output already inspected.
  useEffect(
    () => setRow((prev) => ({ ...initial, output: prev.output })),
    [initial],
  );
  useEffect(() => {
    if (!inspect || busy) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await api("jobs/" + initial.id, undefined, (v) =>
          modelJob(v, initial.id),
        );
        if (!live) return;
        setRow(next);
        setError("");
        // A terminal state is not a release until the runner confirms stop.
        if (!terminal.includes(next.state) || next.reservationHeld)
          timer = setTimeout(poll, 2000);
      } catch (e) {
        if (!live) return;
        setError(errorMessage(e));
        if (denied(e)) deniedCallback.current();
      }
    }
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [initial, inspect, refresh, busy]);
  async function cancel() {
    setBusy(true);
    try {
      setRow(
        await api("jobs/" + row.id + "/cancel", {}, (v) => modelJob(v, row.id)),
      );
      setError("");
    } catch (e) {
      setError(errorMessage(e));
      if (denied(e)) deniedCallback.current();
    } finally {
      setBusy(false);
    }
  }
  return (
    <article
      className="min-w-0 space-y-3 rounded-lg border p-4"
      aria-label={"Model job " + row.id}
    >
      <h3 className="break-all font-semibold">{row.model}</h3>
      <p className="break-all text-sm text-muted-foreground">
        {short(row.digest)} · host {row.hostId} · {row.id}
      </p>
      <p role="status">
        {stateLabels[row.state]}
        {row.cancelRequested && !terminal.includes(row.state)
          ? " · Cancellation requested"
          : ""}
      </p>
      {row.detail && <p className="break-words">{row.detail}</p>}
      <p>
        {row.reservationHeld
          ? "Capacity reserved"
          : "Runtime stopped · capacity released"}
      </p>
      {row.output && (
        <>
          <h4>Output</h4>
          <pre className="overflow-auto whitespace-pre-wrap break-words">
            {row.output.text}
          </pre>
          <p className="text-sm text-muted-foreground">
            {row.output.inputTokens} input tokens · {row.output.outputTokens}{" "}
            output tokens
          </p>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {!inspect && row.state === "succeeded" && (
          <Button variant="outline" onClick={() => setInspect(true)}>
            Show output
          </Button>
        )}
        {error && (
          <Button variant="outline" onClick={() => setRefresh((n) => n + 1)}>
            Refresh status
          </Button>
        )}
        {!terminal.includes(row.state) && !row.cancelRequested && (
          <Button disabled={busy} variant="outline" onClick={cancel}>
            Cancel job
          </Button>
        )}
      </div>
    </article>
  );
}

export function ModelRuns({ onDenied }: { onDenied: () => void }) {
  const [offers, setOffers] = useState<Offer[]>();
  const [choice, setChoice] = useState("");
  const [prompt, setPrompt] = useState("");
  const [maxTokens, setMaxTokens] = useState("600");
  const [rows, setRows] = useState<Job[]>();
  const [followed, setFollowed] = useState<string[]>([]);
  const [pending, setPending] = useState<Submission>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [offerError, setOfferError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const deniedCallback = useRef(onDenied);
  deniedCallback.current = onDenied;
  useEffect(() => {
    let live = true;
    void api("models", undefined, (v) => {
      const items = record(v).models;
      if (!Array.isArray(items)) throw Error("Invalid model offers.");
      return items.map(modelOffer);
    })
      .then((list) => {
        if (!live) return;
        setOffers(list);
        setOfferError("");
        const ready = list.filter((o) => o.online && o.accepting);
        setChoice((prev) =>
          ready.some((o) => key(o) === prev)
            ? prev
            : ready[0]
              ? key(ready[0])
              : "",
        );
      })
      .catch((e) => {
        if (!live) return;
        setOffers([]);
        setChoice("");
        setOfferError(errorMessage(e));
        if (denied(e)) deniedCallback.current();
      });
    void api("jobs", undefined, (v) => {
      const items = record(v).jobs;
      if (!Array.isArray(items)) throw Error("Invalid model job list.");
      return items.map((item) => modelJob(item));
    })
      .then((list) => {
        if (!live) return;
        setRows(list);
        setLoadError("");
      })
      .catch((e) => {
        if (!live) return;
        setLoadError(errorMessage(e));
        if (denied(e)) deniedCallback.current();
      });
    return () => {
      live = false;
    };
  }, [refresh]);
  // One entry per exact model identity; hosts are placement, not choice.
  const choices = [
    ...new Map(
      (offers ?? []).map((o) => [
        key(o),
        {
          id: o.id,
          digest: o.digest,
          ready: (offers ?? []).filter(
            (x) => key(x) === key(o) && x.online && x.accepting,
          ).length,
        },
      ]),
    ).values(),
  ];
  async function submit() {
    setBusy(true);
    setError("");
    try {
      let body = pending;
      if (!body) {
        const selected = choices.find((c) => key(c) === choice);
        const tokens = Number(maxTokens);
        if (!selected || !selected.ready)
          throw Error("Choose a model offered by an online, accepting host.");
        if (!prompt.trim()) throw Error("Enter a prompt.");
        if (!Number.isInteger(tokens) || tokens < 1 || tokens > 4096)
          throw Error("Maximum output tokens must be between 1 and 4096.");
        if (
          new TextEncoder().encode(prompt).length > 65536 ||
          JSON.stringify(prompt).length > 65536
        )
          throw Error("The prompt exceeds the 64 KiB limit.");
        body = {
          id: crypto.randomUUID(),
          model: selected.id,
          digest: selected.digest,
          prompt,
          maxTokens: tokens,
        };
        setPending(body);
      }
      const id = body.id;
      const next = await api("jobs", body, (v) => modelJob(v, id));
      setFollowed((prev) => [...prev, id]);
      setRows((prev) => [next, ...(prev ?? []).filter((r) => r.id !== id)]);
      setPending(undefined);
    } catch (e) {
      setError(errorMessage(e));
      if (denied(e)) deniedCallback.current();
      // A definite rejection created no job; an unknown outcome keeps the ID.
      if (
        e instanceof Error &&
        "status" in e &&
        [400, 409, 413, 422].includes(Number(e.status)) &&
        !("outcome" in e)
      )
        setPending(undefined);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="min-w-0 space-y-6">
      <h1 className="font-display text-3xl">Models</h1>
      <form
        className="space-y-4 rounded-lg border p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <fieldset className="grid min-w-0 gap-3" disabled={busy || !!pending}>
          <label>
            Installed model
            <select
              className="block w-full"
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
            >
              {choices.map((c) => (
                <option key={key(c)} value={key(c)} disabled={!c.ready}>
                  {c.id} · {short(c.digest)} ·{" "}
                  {c.ready
                    ? `${c.ready} ready host${c.ready === 1 ? "" : "s"}`
                    : "no ready host"}
                </option>
              ))}
            </select>
          </label>
          <label>
            Prompt
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </label>
          <label>
            Maximum output tokens
            <Input
              type="number"
              min={1}
              max={4096}
              value={maxTokens}
              onChange={(e) => setMaxTokens(e.target.value)}
            />
          </label>
        </fieldset>
        {error && <p role="alert">{error}</p>}
        {pending && (
          <p>
            Request <code>{pending.id}</code>
          </p>
        )}
        <Button disabled={busy || (!pending && !choice)}>
          {pending ? "Retry same request" : "Run model"}
        </Button>
      </form>
      <h2 className="text-xl">Recent model jobs</h2>
      {offerError && <p role="alert">Model offers unavailable: {offerError}</p>}
      {offers && !offers.length && !offerError && (
        <p role="status">No host offers an installed model.</p>
      )}
      {loadError && <p role="alert">{loadError}</p>}
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => setRefresh((n) => n + 1)}
      >
        Refresh models and jobs
      </Button>
      {rows?.map((row) => (
        <JobRow
          key={row.id}
          initial={row}
          follow={followed.includes(row.id)}
          onDenied={onDenied}
        />
      ))}
      {!rows?.length && !loadError && (
        <p role="status">{rows ? "No model jobs yet." : "Loading jobs…"}</p>
      )}
    </section>
  );
}
