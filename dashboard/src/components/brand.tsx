import { Rocket } from "lucide-react";

export function BrandMark() {
  return (
    <Rocket
      className="size-7 shrink-0 rounded-sm bg-sidebar-primary p-1.5 text-sidebar-primary-foreground"
      strokeWidth={1.5}
      aria-hidden="true"
    />
  );
}

export function Brand() {
  return (
    <span className="inline-flex items-center gap-2 text-foreground">
      <BrandMark />
      <span className="font-display text-base font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
        canaveral
      </span>
    </span>
  );
}
