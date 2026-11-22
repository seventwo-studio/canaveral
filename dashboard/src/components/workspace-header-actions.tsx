import type { ReactNode } from "react";
import { createPortal } from "react-dom";

export function WorkspaceHeaderActions({
  container,
  children,
}: {
  container?: HTMLElement | null;
  children: ReactNode;
}) {
  return container ? createPortal(children, container) : children;
}
