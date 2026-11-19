import { useRef } from "react";
import type { Machine } from "@/lib/inventory";
import type { Host } from "@/lib/infrastructure";
import { machineStatus, memory, number } from "@/lib/api";
import { ownerLabel } from "@/lib/admin";
import type { User } from "@/lib/inventory";
import { Monitor, MoreHorizontal } from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "./ui/dropdown-menu";

export function MachineInventory({
  machines,
  hosts,
  users,
  admin,
  busy,
  onInspect,
  onControl,
  onLifecycle,
  onPowerOff,
  onCapture,
  onDelete,
}: {
  machines: Machine[];
  hosts: Host[];
  users: User[];
  admin: boolean;
  busy: boolean;
  onInspect: (id: string, trigger: Element | null) => void;
  onControl: (id: string) => void;
  onLifecycle: (machine: Machine) => void;
  onPowerOff: (id: string, trigger: Element | null) => void;
  onCapture: (id: string, trigger: Element | null) => void;
  onDelete: (id: string, trigger: Element | null) => void;
}) {
  return (
    <div className="min-w-0 overflow-hidden rounded-md border bg-card">
      <div
        aria-hidden="true"
        className="hidden grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1fr)_13rem] items-center gap-4 border-b bg-muted/50 px-4 py-3 text-xs font-medium text-muted-foreground xl:grid"
      >
        <span>Machine</span>
        <span>State</span>
        <span>Resources</span>
        <span>{admin ? "Host / owner" : "Host"}</span>
        <span className="text-right">Actions</span>
      </div>
      <ul className="divide-y" aria-label="Machine list">
        {machines.map((m) => (
          <MachineRow
            key={m.id}
            machine={m}
            host={hosts.find((h) => h.id === m.hostId)}
            users={users}
            admin={admin}
            busy={busy}
            onInspect={onInspect}
            onControl={onControl}
            onLifecycle={onLifecycle}
            onPowerOff={onPowerOff}
            onCapture={onCapture}
            onDelete={onDelete}
          />
        ))}
      </ul>
    </div>
  );
}
function MachineRow({
  machine: m,
  host,
  users,
  admin,
  busy,
  onInspect,
  onControl,
  onLifecycle,
  onPowerOff,
  onCapture,
  onDelete,
}: Omit<Parameters<typeof MachineInventory>[0], "machines" | "hosts"> & {
  machine: Machine;
  host?: Host;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const pending = useRef<(() => void) | null>(null);
  const status = machineStatus(m);
  const controllable =
    m.ready &&
    m.observed === "running" &&
    (m.template.mode === "device" || m.template.guestAccess);
  const deletable =
    !!m.deletion ||
    (m.desired === "stopped" &&
      m.observed === "stopped" &&
      !m.powerOffRequest &&
      host?.online !== false);
  const powerOff =
    !m.deletion &&
    (!!m.powerOffRequest ||
      (m.template.mode !== "device" &&
        m.observed !== "stopped" &&
        host?.online &&
        ["macos", "apple"].includes(host.provider)));
  return (
    <li
      data-machine-id={m.id}
      className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-2 px-4 py-3 focus-within:bg-muted/30 sm:gap-y-3 sm:py-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1fr)_13rem] xl:items-center xl:hover:bg-muted/30"
    >
      <div className="flex min-w-0 items-start gap-3">
        <Monitor
          aria-hidden="true"
          className="hidden size-8 shrink-0 rounded-md border bg-muted/50 p-1.5 text-muted-foreground sm:block"
        />
        <div className="min-w-0 space-y-1">
          <Button
            variant="link"
            className="h-auto max-w-full justify-start whitespace-normal p-0 text-left font-display text-base font-medium text-foreground [overflow-wrap:anywhere]"
            onClick={(e) => onInspect(m.id, e.currentTarget)}
          >
            {m.name}
          </Button>
          <p className="text-xs text-muted-foreground">
            {m.template.os} · {m.template.arch}
          </p>
        </div>
      </div>
      <div className="min-w-0 justify-self-end space-y-1 xl:justify-self-start">
        <Badge
          variant="outline"
          className={`status status-${status.toLowerCase().replaceAll(" ", "-")}`}
        >
          <span className="status-dot" aria-hidden="true" />
          {status}
        </Badge>
        {m.desired !== m.observed &&
          !["error", "unknown"].includes(m.observed) && (
            <p className="text-xs text-muted-foreground">
              {m.desired === "running" ? "Start" : "Stop"} requested
            </p>
          )}
        {m.powerOffRequest && (
          <p className="text-xs text-muted-foreground">Power-off pending</p>
        )}
        {m.deletion && (
          <p className="text-xs text-muted-foreground">
            {m.deletion.state === "blocked"
              ? "Removal unconfirmed; storage retained"
              : "Waiting for host to confirm removal"}
          </p>
        )}
      </div>
      <dl className="min-w-0 text-xs">
        <dt className="mb-1 text-muted-foreground xl:sr-only">Resources</dt>
        <dd className="break-words font-mono tabular-nums">
          {m.resources.cpu} vCPU · {memory(m.resources.memoryMiB)}
          <span className="mt-1 block text-muted-foreground">
            {number(m.resources.diskGiB)} GiB disk
          </span>
        </dd>
      </dl>
      <dl className="min-w-0 space-y-1 text-xs">
        <dt className="text-muted-foreground xl:sr-only">Host</dt>
        <dd className="[overflow-wrap:anywhere]">
          {host?.name || "Unknown host"}
        </dd>
        {admin && (
          <>
            <dt className="sr-only">Owner</dt>
            <dd className="text-muted-foreground [overflow-wrap:anywhere]">
              {ownerLabel(m, users)}
            </dd>
          </>
        )}
      </dl>
      <div className="col-span-2 flex flex-wrap items-center gap-2 xl:col-span-1 xl:flex-nowrap xl:justify-end">
        {m.deletion ? null : controllable ? (
          <Button size="sm" onClick={() => onControl(m.id)}>
            Control
          </Button>
        ) : m.observed === "stopped" && m.desired !== "running" ? (
          <Button
            size="sm"
            disabled={busy || !!m.powerOffRequest}
            aria-label={`Start ${m.name}`}
            onClick={() => onLifecycle(m)}
          >
            Start
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={(e) => onInspect(m.id, e.currentTarget)}
          >
            Details<span className="sr-only"> {m.name}</span>
          </Button>
        )}
        {!m.deletion &&
          !(m.observed === "stopped" && m.desired !== "running") && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !!m.powerOffRequest}
              aria-label={`${m.desired === "running" ? "Stop" : "Start"} ${m.name}`}
              onClick={() => onLifecycle(m)}
            >
              {m.desired === "running" ? "Stop" : "Start"}
            </Button>
          )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              ref={trigger}
              variant="ghost"
              size="icon-sm"
              aria-label={`More actions for ${m.name}`}
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            onCloseAutoFocus={(e) => {
              const action = pending.current;
              pending.current = null;
              if (action) {
                e.preventDefault();
                trigger.current?.focus();
                action();
              }
            }}
          >
            <DropdownMenuItem
              onSelect={() => {
                pending.current = () => onInspect(m.id, trigger.current);
              }}
            >
              Machine details
            </DropdownMenuItem>
            {admin && m.template.mode !== "device" && (
              <DropdownMenuItem
                disabled={
                  busy ||
                  m.desired !== "stopped" ||
                  m.observed !== "stopped" ||
                  !!m.powerOffRequest
                }
                onSelect={() => {
                  pending.current = () => onCapture(m.id, trigger.current);
                }}
              >
                Capture snapshot
              </DropdownMenuItem>
            )}
            {deletable && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  disabled={busy}
                  onSelect={() => {
                    pending.current = () => onDelete(m.id, trigger.current);
                  }}
                >
                  {m.deletion ? "Check deletion status" : "Delete machine"}
                  <span className="sr-only"> {m.name}</span>
                </DropdownMenuItem>
              </>
            )}
            {powerOff && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  disabled={busy}
                  onSelect={() => {
                    pending.current = () => onPowerOff(m.id, trigger.current);
                  }}
                >
                  {m.powerOffRequest ? "Check power-off status" : "Power off"}
                  <span className="sr-only"> {m.name}</span>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}
