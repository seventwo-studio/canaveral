import type { VariantProps } from "class-variance-authority";
import * as React from "react";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Slot } from "radix-ui";

const badgeVariants = cva(
  "inline-flex min-h-5 w-fit max-w-full items-center justify-center gap-1 rounded-full border border-transparent px-1.5 py-px text-xs leading-4 font-normal [overflow-wrap:anywhere] transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
        secondary: "bg-muted text-muted-foreground [a&]:hover:bg-accent",
        success: "bg-[#edf6e6] text-[#456b2f]",
        warning: "bg-[#fbf2db] text-[var(--state-pending)]",
        destructive:
          "bg-[#fcecea] text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/15 dark:focus-visible:ring-destructive/40 [a&]:hover:bg-destructive/15",
        outline:
          "border-border text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        ghost: "[a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        link: "text-primary underline-offset-4 [a&]:hover:underline",
      },
    },
    defaultVariants: {
      variant: "secondary",
    },
  },
);

// Unknown controller states retain their label and neutral treatment.
export function statusBadgeVariant(state: string) {
  switch (state.toLowerCase()) {
    case "ready":
    case "online":
    case "active":
    case "completed":
    case "succeeded":
      return "success";
    case "waiting for capacity":
    case "waiting for resources":
    case "provisioning":
    case "preparing":
    case "pending":
    case "draining":
    case "waiting":
    case "queued":
    case "deleting":
      return "warning";
    case "error":
    case "failed":
    case "setup failed":
    case "deletion blocked":
      return "destructive";
    default:
      return "secondary";
  }
}

function Badge({
  className,
  variant = "secondary",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span";

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

function StatusBadge({
  state,
  ...props
}: Omit<React.ComponentProps<typeof Badge>, "variant" | "children"> & {
  state: string;
}) {
  return (
    <Badge variant={statusBadgeVariant(state)} {...props}>
      {state}
    </Badge>
  );
}

export { Badge, badgeVariants, StatusBadge };
