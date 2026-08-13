import * as React from "react";
import { X } from "lucide-react";

import {
  clearLinkPreviewDiagnostics,
  type LinkPreviewDiagnostic,
} from "@/features/messages/lib/linkPreviewPreparationStore";
import { Button } from "@/shared/ui/button";

function shortUrl(href: string): string {
  try {
    const url = new URL(href);
    return `${url.hostname.replace(/^www\./, "")}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return href;
  }
}

function elapsedSeconds(
  diagnostic: LinkPreviewDiagnostic,
  now: number,
): string {
  const stoppedAt =
    diagnostic.terminalAt ?? Math.max(diagnostic.updatedAt, now);
  return `${((stoppedAt - diagnostic.startedAt) / 1_000).toFixed(1)}s`;
}

function mediaReason(
  outcome: LinkPreviewDiagnostic["image"],
  terminalReason: LinkPreviewDiagnostic["terminalReason"],
): string {
  if (outcome === "pending" && terminalReason === "timeout") {
    return "timed-out-pending";
  }
  if (outcome === "not-provided") return "metadata-no-media";
  return outcome;
}

export function LinkPreviewDebugOverlay({
  diagnostics,
}: {
  diagnostics: readonly LinkPreviewDiagnostic[];
}) {
  const hasActiveJob = diagnostics.some(
    (diagnostic) => diagnostic.terminalReason === null,
  );
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    if (!hasActiveJob) return;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [hasActiveJob]);

  if (diagnostics.length === 0) return null;

  // TEMPORARY DEBUGGING HARNESS: remove this entire overlay after the link
  // preview enrichment inconsistency has been diagnosed. It is intentionally
  // always visible so pre-submit and promoted post-submit runs can be compared.
  return (
    <section
      aria-label="Link preview diagnostics"
      className="pointer-events-auto mx-auto mb-2 w-[min(42rem,calc(100%-1rem))] overflow-hidden rounded-lg border border-amber-400/60 bg-zinc-950/95 font-mono text-2xs leading-4 text-zinc-100 shadow-xl"
      data-testid="link-preview-debug-overlay"
    >
      <header className="flex items-center justify-between border-b border-amber-400/30 bg-amber-400/10 px-2 py-1">
        <strong className="text-amber-300">
          TEMP link-preview diagnostics
        </strong>
        <Button
          aria-label="Clear link preview diagnostics"
          className="size-5 text-zinc-300 hover:bg-white/10 hover:text-white"
          onClick={clearLinkPreviewDiagnostics}
          size="icon-xs"
          title="Clear diagnostics"
          variant="ghost"
        >
          <X aria-hidden="true" />
        </Button>
      </header>
      <div className="max-h-44 overflow-y-auto">
        {diagnostics.map((diagnostic) => (
          <div
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-b border-white/10 px-2 py-1 last:border-0"
            data-diagnostic-href={diagnostic.href}
            key={diagnostic.href}
          >
            <span className="truncate text-zinc-200" title={diagnostic.href}>
              {shortUrl(diagnostic.href)}
            </span>
            <span className="text-right text-amber-200">
              {diagnostic.mode} · {elapsedSeconds(diagnostic, now)}
            </span>
            <span className="col-span-2 text-zinc-400">
              {diagnostic.stage} · meta:{diagnostic.metadata} · img:
              {mediaReason(diagnostic.image, diagnostic.terminalReason)} · icon:
              {mediaReason(diagnostic.favicon, diagnostic.terminalReason)} ·
              result:
              {diagnostic.result} · terminal:
              {diagnostic.terminalReason ?? "—"}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
