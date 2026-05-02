// ============================================================
// DelegateWidget — TUI widget showing parent + delegate status
// ============================================================

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { DelegateRegistry } from "./types.js";

/**
 * Build the widget lines from current registry + active sessions.
 */
export function getWidgetLines(
  registry: DelegateRegistry,
  activeSessions: Map<string, AgentSession>,
): string[] {
  const boxes: string[] = ["parent"];

  for (const rec of Object.values(registry.delegates)) {
    const session = activeSessions.get(rec.id);
    const isStreaming = session?.isStreaming ?? false;

    let icon: string;
    if (isStreaming) {
      icon = "⠋";
    } else if (rec.status === "done") {
      icon = "✓";
    } else if (rec.status === "failed") {
      icon = "✗";
    } else if (rec.status === "running") {
      icon = "⠋";
    } else {
      icon = "●";
    }

    boxes.push(`${icon} ${rec.id}`);
  }

  if (boxes.length === 1) return [];

  const line = boxes.join("  │  ");
  return [line];
}

/**
 * Render (or refresh) the above-editor widget.
 */
export function refreshWidget(
  ctx: ExtensionContext,
  registry: DelegateRegistry,
  activeSessions: Map<string, AgentSession>,
): void {
  const lines = getWidgetLines(registry, activeSessions);
  if (lines.length > 0) {
    ctx.ui.setWidget("delegates", lines, { placement: "aboveEditor" });
  } else {
    ctx.ui.setWidget("delegates", undefined);
  }
}
