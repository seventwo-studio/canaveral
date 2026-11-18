import { Rocket } from "lucide-react";

export function Brand() {
  return (
    <span className="inline-flex items-center gap-2.5 text-foreground">
      <Rocket
        className="size-9 shrink-0 rounded-md bg-primary p-2 text-primary-foreground"
        strokeWidth={1.5}
        aria-hidden="true"
      />
      <span className="font-display text-xl font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
        canaveral
      </span>
    </span>
  );
}
