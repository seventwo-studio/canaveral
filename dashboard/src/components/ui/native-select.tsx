import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function NativeSelect({
  className,
  ...props
}: ComponentProps<"select">) {
  return (
    <select
      {...props}
      data-slot="native-select"
      className={cn(
        "h-8 w-full min-w-0 rounded-md border border-input bg-card pl-2.5 pr-7 text-base font-normal text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 md:text-[13px]",
        className,
      )}
    />
  );
}
