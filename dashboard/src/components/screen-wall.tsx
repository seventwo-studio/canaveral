import { useEffect, useRef, useState } from "react";
import { provider } from "@/lib/api";
import { ownerLabel } from "@/lib/admin";
import type { Host } from "@/lib/infrastructure";
import type { Machine, User } from "@/lib/inventory";
import { createLivePlayer } from "@/lib/live-player";
import { watchLive, type LiveEnding } from "@/lib/live-view";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";

/** Screens watched side by side. A device accepts four viewers and a host four captures, so four is
 * also the most one page can ask of a single host. */
export const WALL_LIMIT = 4;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A device the wall may offer: a running Android or iOS device that belongs to an account.
 * A leased machine never has a user owner, so requiring one keeps every leased device off this
 * page; the controller refuses a leased device on the live-view route as well. A device without a
 * user owner is left out for the same reason, whoever is signed in. */
export function watchable(machine: Machine): boolean {
  return (
    machine.template.mode === "device" &&
    ["android", "ios"].includes(machine.template.os) &&
    typeof machine.ownerId === "string" &&
    machine.desired === "running" &&
    machine.observed === "running" &&
    !machine.deletion
  );
}
/** `#screens/<uuid>+<uuid>` names the devices on the wall, so a reload or a shared link shows the
 * same ones. Nothing is kept in browser storage. */
export function wallSelection(hash: string): string[] {
  const [name, list, ...rest] = hash.replace(/^#/, "").split("/");
  if (name !== "screens" || !list || rest.length) return [];
  return [...new Set(list.split("+").filter((id) => UUID.test(id)))].slice(
    0,
    WALL_LIMIT,
  );
}

export function ScreenWall({
  machines,
  hosts,
  users,
  admin,
  loaded,
  stale,
  onControl,
  onDenied,
}: {
  machines: Machine[];
  hosts: Host[];
  users: User[];
  admin: boolean;
  loaded: boolean;
  /** The inventory's stale notice, when its last refresh failed. */
  stale: string;
  onControl: (id: string) => void;
  onDenied: () => void;
}) {
  const [selected, setSelected] = useState(() => wallSelection(location.hash));
  useEffect(() => {
    const next = selected.length
      ? `#screens/${selected.join("+")}`
      : "#screens";
    // The address follows the wall without adding a history entry for every change.
    if (location.hash !== next) history.replaceState(null, "", next);
  }, [selected]);
  const candidates = machines.filter(watchable);
  // An ordinary account does not see hosts; the name is left out rather than shown as unknown.
  const hostName = (id: string) => hosts.find((host) => host.id === id)?.name;
  const where = (machine: Machine) =>
    [
      provider(machine.template.os),
      hostName(machine.hostId),
      admin ? ownerLabel(machine, users) : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
  const full = selected.length >= WALL_LIMIT;
  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id)
        ? current.filter((value) => value !== id)
        : current.length < WALL_LIMIT
          ? [...current, id]
          : current,
    );
  return (
    <div className="min-w-0 space-y-6">
      <div className="min-w-0 space-y-1">
        <p className="max-w-prose text-sm text-muted-foreground">
          Watch up to four devices. Open control to interact with a live screen.
          Only account-owned devices appear here: a leased device's screen
          belongs to its lease holder and is never shown here.
        </p>
      </div>
      {stale && (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="text-foreground">
            The device list is stale. {stale}
          </AlertDescription>
        </Alert>
      )}
      {selected.length > 0 && (
        <section aria-label="Watched screens" className="min-w-0">
          <ul className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {selected.map((id) => {
              const machine = machines.find((m) => m.id === id);
              return (
                <li key={id} className="min-w-0">
                  {machine && watchable(machine) ? (
                    <ScreenTile
                      machine={machine}
                      where={where(machine)}
                      onControl={onControl}
                      onRemove={() => toggle(id)}
                      onDenied={onDenied}
                    />
                  ) : (
                    <article
                      aria-label={`Screen of ${machine?.name ?? id}`}
                      className="flex h-full min-w-0 flex-col gap-3 rounded-md border bg-card p-4"
                    >
                      <h2 className="text-sm font-semibold [overflow-wrap:anywhere]">
                        {machine?.name ?? (
                          <span className="font-mono text-xs">{id}</span>
                        )}
                      </h2>
                      <p className="text-sm text-muted-foreground">
                        {!loaded
                          ? "Loading the device list…"
                          : machine
                            ? "This device is not running, or is not an account-owned mobile device. Its screen returns here when it runs again."
                            : "This device is not in your device list."}
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-auto self-start"
                        onClick={() => toggle(id)}
                      >
                        Remove from the wall
                      </Button>
                    </article>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <section className="min-w-0 space-y-3" aria-labelledby="wall-devices">
        <div className="space-y-1">
          <h2
            id="wall-devices"
            className="text-base font-semibold tracking-tight"
          >
            Devices you can watch{" "}
            <span className="text-muted-foreground">({candidates.length})</span>
          </h2>
          <details className="max-w-prose text-[13px] text-muted-foreground">
            <summary className="w-fit cursor-pointer">
              Capture capacity and limits
            </summary>
            <p className="mt-1">
              Watching a device runs one screen capture on its host for as long
              as its picture is on screen: one of that host's four video
              sessions, with one CPU and 256 MiB reserved. A tile that is
              scrolled away, or a tab in the background, stops renewing its
              view, and the capture then stops within a minute.
            </p>
          </details>
        </div>
        {full && (
          <p className="text-sm" role="status">
            The wall shows four screens at most. Stop watching one to add
            another.
          </p>
        )}
        {!candidates.length ? (
          <Empty showIcon={loaded && !stale}>
            <EmptyHeader>
              <EmptyTitle>
                {stale
                  ? "Device inventory is unavailable"
                  : loaded
                    ? "No running mobile device to watch"
                    : "Loading the device list…"}
              </EmptyTitle>
              {loaded && !stale && (
                <EmptyDescription>
                  An Android or iOS device appears here while it is running and
                  belongs to {admin ? "an account" : "your account"}. Create or
                  start one under Machines. Stopped devices, desktops and
                  devices without a user owner are not listed.
                </EmptyDescription>
              )}
            </EmptyHeader>
          </Empty>
        ) : (
          <ul
            aria-label="Devices you can watch"
            className="min-w-0 divide-y border-y bg-card"
          >
            {candidates.map((machine) => {
              const watching = selected.includes(machine.id);
              return (
                <li
                  key={machine.id}
                  className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold [overflow-wrap:anywhere]">
                      {machine.name}
                    </p>
                    <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                      {where(machine)}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!watching && full}
                    aria-pressed={watching}
                    aria-label={`${watching ? "Stop watching" : "Watch"} ${machine.name}`}
                    onClick={() => toggle(machine.id)}
                  >
                    {watching ? "Stop watching" : "Watch"}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

type Phase = "connecting" | "waiting" | "live" | "ended";
/** One device's picture. The tile owns one live view: it opens it when it mounts, renews it only
 * while the picture is on screen, and closes it when it unmounts or the page goes away. */
function ScreenTile({
  machine,
  where,
  onControl,
  onRemove,
  onDenied,
}: {
  machine: Machine;
  /** Platform, host and owner, as far as the signed-in account may know them. */
  where: string;
  onControl: (id: string) => void;
  onRemove: () => void;
  onDenied: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("connecting");
  const [ending, setEnding] = useState<LiveEnding | null>(null);
  const [problem, setProblem] = useState("");
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  /** Each attempt is one view. A new attempt starts a new view from scratch. */
  const [attempt, setAttempt] = useState(0);
  const video = useRef<HTMLVideoElement>(null),
    frame = useRef<HTMLDivElement>(null),
    deniedCallback = useRef(onDenied);
  deniedCallback.current = onDenied;

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    let over = false,
      onScreen = true,
      // A view that lapsed while its picture was away is reopened when the picture returns.
      lapsed = false,
      away = false;
    setPhase("connecting");
    setEnding(null);
    setProblem("");
    const player = createLivePlayer(element, {
      onPicture(picture) {
        if (over) return;
        setSize(picture);
        setPhase("live");
      },
      onProblem(message) {
        if (over) return;
        // The stream cannot be shown here; the view is left so its capture can stop.
        over = true;
        view.close();
        setProblem(message);
        setPhase("ended");
      },
    });
    const view = watchLive(machine.id, {
      onLive() {
        if (!over)
          setPhase((current) => (current === "live" ? current : "waiting"));
      },
      onInit(_epoch, data) {
        player.init(data);
      },
      onSegment(segment) {
        player.append(segment.data);
      },
      onEnd(result) {
        if (over) return;
        over = true;
        if (result.reason === "view_expired" && away) {
          // The picture is back already: open the next view without showing an ending.
          if (visible()) {
            setAttempt((value) => value + 1);
            return;
          }
          lapsed = true;
        }
        if (result.reason === "unauthenticated") deniedCallback.current();
        setEnding(result);
        setPhase("ended");
      },
    });
    const visible = () => !document.hidden && onScreen;
    const sync = () => {
      const now = visible();
      if (!now) away = true;
      view.setWatched(now);
      if (now && lapsed) {
        lapsed = false;
        setAttempt((value) => value + 1);
      }
    };
    const observer =
      typeof IntersectionObserver === "undefined" || !frame.current
        ? undefined
        : new IntersectionObserver((entries) => {
            onScreen = entries.some((entry) => entry.isIntersecting);
            sync();
          });
    if (observer && frame.current) observer.observe(frame.current);
    const leave = () => view.close(true);
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("pagehide", leave);
    sync();
    return () => {
      over = true;
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("pagehide", leave);
      observer?.disconnect();
      view.close();
      player.destroy();
    };
  }, [machine.id, attempt]);

  // An ending that is an ordinary state, such as a host that does not offer live views, is shown
  // as that state. Only a failure reads as one.
  const calm = phase === "ended" && !problem && !!ending?.state;
  const status =
    phase === "live"
      ? "Live"
      : phase === "waiting"
        ? "Connected"
        : phase === "connecting"
          ? "Connecting"
          : calm
            ? ending!.state!
            : "Ended";
  const detail =
    phase === "connecting"
      ? "Opening the live view…"
      : phase === "waiting"
        ? "Connected. The picture appears with the next frame; a still Android screen sends none until it changes."
        : phase === "ended"
          ? problem || ending?.message || "The view ended."
          : "";
  const controllable = machine.ready;
  return (
    <article
      aria-label={`Live screen of ${machine.name}`}
      className="flex h-full min-w-0 flex-col gap-3 rounded-md border bg-card p-3"
    >
      <header className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold [overflow-wrap:anywhere]">
            {machine.name}
          </h2>
          <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {where}
          </p>
        </div>
        <Badge
          variant="outline"
          className={`status ${phase === "live" ? "status-ready" : phase === "ended" && !calm ? "status-error" : phase === "ended" ? "" : "status-pending"}`}
        >
          <span className="status-dot" aria-hidden="true" />
          {status}
        </Badge>
      </header>
      <div
        ref={frame}
        className="relative mx-auto flex max-h-[70svh] w-full items-center justify-center overflow-hidden rounded-sm bg-neutral-950"
        style={{
          aspectRatio: size ? `${size.width} / ${size.height}` : "9 / 19.5",
        }}
      >
        {/* Watch-only: no controls and no input. The device is acted on through its control page. */}
        <video
          ref={video}
          className={`pointer-events-none size-full object-contain ${phase === "live" ? "" : "invisible"}`}
          aria-label={`Screen of ${machine.name}`}
          muted
          playsInline
          autoPlay
          disablePictureInPicture
          tabIndex={-1}
        />
        {phase !== "live" && (
          <p
            role={phase === "ended" && !calm ? "alert" : "status"}
            className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-neutral-200"
          >
            {detail}
          </p>
        )}
      </div>
      <footer className="mt-auto flex min-w-0 flex-wrap gap-2">
        {controllable && (
          <Button
            size="sm"
            variant="outline"
            aria-label={`Open control of ${machine.name}`}
            onClick={() => onControl(machine.id)}
          >
            Open control
          </Button>
        )}
        {phase === "ended" && !problem && ending?.again !== "no" && (
          <Button
            size="sm"
            variant="outline"
            aria-label={`Watch ${machine.name} again`}
            onClick={() => setAttempt((value) => value + 1)}
          >
            Watch again
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          aria-label={`Stop watching ${machine.name}`}
          onClick={onRemove}
        >
          Stop watching
        </Button>
      </footer>
    </article>
  );
}
