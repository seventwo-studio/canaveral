import { Rocket } from "lucide-react";

export function Brand() {
  return (
    <span className="inline-flex items-center gap-2 text-sm font-normal text-muted-foreground">
      <Rocket
        className="size-4 shrink-0"
        strokeWidth={1.5}
        aria-hidden="true"
      />
      <span className="bg-primary px-1.5 font-display text-lg font-medium leading-tight text-primary-foreground group-data-[collapsible=icon]:hidden">
        canaveral
      </span>
    </span>
  );
}
