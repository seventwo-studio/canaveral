import { Rocket } from "lucide-react";

export function Brand() {
  return (
    <span className="inline-flex items-center gap-2 text-foreground">
      <Rocket
        className="size-7 shrink-0 rounded bg-sidebar-primary p-1.5 text-white"
        strokeWidth={1.5}
        aria-hidden="true"
      />
      <span className="font-display text-base font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
        canaveral
      </span>
    </span>
  );
}
