import { X } from "lucide-react";

export function FilterChip({
  label,
  value,
  onRemove,
}: {
  label: string;
  value: string;
  onRemove: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`Remove the ${label.toLowerCase()} filter`}
      title={`${label}: ${value}`}
      onClick={onRemove}
      className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-sm border bg-card px-2 text-xs shadow-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <span className="shrink-0 border-r pr-1.5 text-muted-foreground">
        {label}
      </span>
      <span className="truncate">{value}</span>
      <X className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}
