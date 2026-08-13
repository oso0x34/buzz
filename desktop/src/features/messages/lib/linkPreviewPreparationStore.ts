import * as React from "react";

import { uploadMediaBytes } from "@/shared/api/tauri";
import type { SupportedLinkPreview } from "@/shared/lib/linkPreview";
import {
  buildLinkPreviewSnapshotTag,
  isValidLinkPreviewSnapshotCanonicalUrl,
} from "@/shared/lib/linkPreviewSnapshot";
import {
  loadLinkPreviewMetadata,
  resolveLinkPreview,
} from "@/shared/lib/useResolvedLinkPreviews";

const POST_SUBMIT_PREVIEW_BUDGET_MS = 10_000;
const SETTLED_PREVIEW_JOB_TTL_MS = 5 * 60_000;
const MAX_DIAGNOSTIC_JOBS = 8;

type PreviewJob = {
  promise: Promise<string[] | null>;
  fallbackTag: string[] | null;
  resolvedTag: string[] | null;
  settled: boolean;
  settledAt: number | null;
};

type BackgroundPreviewTask = {
  id: number;
  skip: () => void;
};

type DiagnosticStage =
  | "metadata"
  | "metadata-ready"
  | "uploading-media"
  | "resolved"
  | "failed";
type DiagnosticMediaOutcome =
  | "pending"
  | "not-provided"
  | "invalid-data-url"
  | "uploaded"
  | "upload-failed";
type DiagnosticTerminalReason = "complete" | "timeout" | "skip";

export type LinkPreviewDiagnostic = {
  href: string;
  startedAt: number;
  updatedAt: number;
  stage: DiagnosticStage;
  metadata: "pending" | "ready" | "missing" | "invalid" | "failed";
  image: DiagnosticMediaOutcome;
  favicon: DiagnosticMediaOutcome;
  result: "pending" | "resolved" | "fallback" | "failed";
  mode: "pre-submit" | "post-submit";
  terminalAt: number | null;
  terminalReason: DiagnosticTerminalReason | null;
};

type BackgroundPreviewSnapshot = {
  canSkip: boolean;
  diagnostics: readonly LinkPreviewDiagnostic[];
  isPreparing: boolean;
};

export type PreparedBackgroundLinkPreviews = {
  promise: Promise<string[][]>;
  skip: () => void;
};

const jobs = new Map<string, PreviewJob>();
const diagnostics = new Map<string, LinkPreviewDiagnostic>();
const tasks = new Map<number, BackgroundPreviewTask>();
const listeners = new Set<() => void>();
let nextTaskId = 0;
let snapshot: BackgroundPreviewSnapshot = {
  canSkip: false,
  diagnostics: [],
  isPreparing: false,
};

function publishSnapshot(): void {
  const now = Date.now();
  for (const [href, diagnostic] of diagnostics) {
    if (now - diagnostic.updatedAt >= SETTLED_PREVIEW_JOB_TTL_MS) {
      diagnostics.delete(href);
    }
  }
  const recentDiagnostics = [...diagnostics.values()].sort(
    (left, right) => right.updatedAt - left.updatedAt,
  );
  for (const diagnostic of recentDiagnostics.slice(MAX_DIAGNOSTIC_JOBS)) {
    diagnostics.delete(diagnostic.href);
  }
  snapshot = {
    canSkip: tasks.size > 0,
    diagnostics: recentDiagnostics.slice(0, MAX_DIAGNOSTIC_JOBS),
    isPreparing: tasks.size > 0,
  };
  for (const listener of listeners) listener();
}

function updateDiagnostic(
  href: string,
  update: Partial<Omit<LinkPreviewDiagnostic, "href" | "startedAt">>,
): void {
  const now = Date.now();
  const current = diagnostics.get(href) ?? {
    href,
    startedAt: now,
    updatedAt: now,
    stage: "metadata" as const,
    metadata: "pending" as const,
    image: "pending" as const,
    favicon: "pending" as const,
    result: "pending" as const,
    mode: "pre-submit" as const,
    terminalAt: null,
    terminalReason: null,
  };
  diagnostics.set(href, { ...current, ...update, updatedAt: now });
  publishSnapshot();
}

function dataUrlBytes(dataUrl: string): Uint8Array | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  try {
    const binary = atob(dataUrl.slice(comma + 1));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

type UploadResult = {
  failed: boolean;
  outcome: Exclude<DiagnosticMediaOutcome, "pending">;
  sha256: string;
  url: string;
};

async function uploadDataUrl(
  dataUrl: string | null | undefined,
  filename: string,
): Promise<UploadResult> {
  if (!dataUrl) {
    return {
      failed: false,
      outcome: "not-provided",
      sha256: "",
      url: "",
    };
  }
  const bytes = dataUrlBytes(dataUrl);
  if (!bytes) {
    return {
      failed: false,
      outcome: "invalid-data-url",
      sha256: "",
      url: "",
    };
  }
  try {
    const uploaded = await uploadMediaBytes([...bytes], filename);
    return {
      failed: false,
      outcome: "uploaded",
      sha256: uploaded.sha256,
      url: uploaded.url,
    };
  } catch {
    return {
      failed: true,
      outcome: "upload-failed",
      sha256: "",
      url: "",
    };
  }
}

async function buildSnapshot(
  candidate: SupportedLinkPreview,
  onMetadataReady: (tag: string[]) => void,
): Promise<string[] | null> {
  let metadata: Awaited<ReturnType<typeof loadLinkPreviewMetadata>>;
  try {
    metadata = await loadLinkPreviewMetadata(candidate.href);
  } catch (error) {
    updateDiagnostic(candidate.href, {
      metadata: "failed",
      result: "failed",
      stage: "failed",
    });
    throw error;
  }
  if (!metadata) {
    updateDiagnostic(candidate.href, {
      metadata: "missing",
      result: "failed",
      stage: "failed",
    });
    return null;
  }
  const preview = resolveLinkPreview(candidate, metadata);
  if (!preview.snapshotReady) {
    updateDiagnostic(candidate.href, {
      metadata: "invalid",
      result: "failed",
      stage: "failed",
    });
    return null;
  }
  updateDiagnostic(candidate.href, {
    metadata: "ready",
    stage: "metadata-ready",
  });
  const fallbackTag = buildLinkPreviewSnapshotTag({
    canonicalUrl: preview.href,
    title: preview.title,
    siteName: preview.provider,
    description: preview.description ?? "",
    imageUrl: "",
    imageSha256: "",
    faviconUrl: "",
    faviconSha256: "",
  });
  if (!fallbackTag) {
    updateDiagnostic(candidate.href, { result: "failed", stage: "failed" });
    return null;
  }
  onMetadataReady(fallbackTag);
  updateDiagnostic(candidate.href, { stage: "uploading-media" });
  const [image, favicon] = await Promise.all([
    uploadDataUrl(preview.imageDataUrl, "link-preview-image.png"),
    uploadDataUrl(preview.faviconDataUrl, "link-preview-favicon.png"),
  ]);
  const uploadFailed = image.failed || favicon.failed;
  updateDiagnostic(candidate.href, {
    favicon: favicon.outcome,
    image: image.outcome,
    result: uploadFailed ? "fallback" : "resolved",
    stage: uploadFailed ? "failed" : "resolved",
  });
  if (uploadFailed) return fallbackTag;
  return (
    buildLinkPreviewSnapshotTag({
      canonicalUrl: preview.href,
      title: preview.title,
      siteName: preview.provider,
      description: preview.description ?? "",
      imageUrl: image.url,
      imageSha256: image.sha256,
      faviconUrl: favicon.url,
      faviconSha256: favicon.sha256,
    }) ?? fallbackTag
  );
}

function isReusableJob(job: PreviewJob, now = Date.now()): boolean {
  return (
    !job.settled ||
    (job.settledAt !== null && now - job.settledAt < SETTLED_PREVIEW_JOB_TTL_MS)
  );
}

/** Start or adopt the one preparation job for this exact canonical URL. */
export function prepareLinkPreview(
  candidate: SupportedLinkPreview,
): Promise<string[] | null> {
  if (
    candidate.href.startsWith("buzz://") ||
    !isValidLinkPreviewSnapshotCanonicalUrl(candidate.href)
  ) {
    return Promise.resolve(null);
  }
  const existing = jobs.get(candidate.href);
  if (existing && isReusableJob(existing)) {
    return existing.promise;
  }
  if (existing) jobs.delete(candidate.href);

  updateDiagnostic(candidate.href, {
    favicon: "pending",
    image: "pending",
    metadata: "pending",
    result: "pending",
    stage: "metadata",
    terminalAt: null,
    terminalReason: null,
  });
  const job: PreviewJob = {
    promise: Promise.resolve(null),
    fallbackTag: null,
    resolvedTag: null,
    settled: false,
    settledAt: null,
  };
  job.promise = buildSnapshot(candidate, (fallbackTag) => {
    job.fallbackTag = fallbackTag;
  })
    .catch(() => null)
    .then((tag) => {
      job.resolvedTag = tag;
      if (tag === null && jobs.get(candidate.href) === job) {
        jobs.delete(candidate.href);
      }
      return tag;
    })
    .finally(() => {
      job.settled = true;
      job.settledAt = Date.now();
      const diagnostic = diagnostics.get(candidate.href);
      updateDiagnostic(candidate.href, {
        result:
          diagnostic?.result === "pending" ? "failed" : diagnostic?.result,
        stage: diagnostic?.stage === "metadata" ? "failed" : diagnostic?.stage,
        terminalAt: diagnostic?.terminalAt ?? Date.now(),
        terminalReason: diagnostic?.terminalReason ?? "complete",
      });
    });
  jobs.set(candidate.href, job);
  return job.promise;
}

/**
 * Promote the frozen composer generation into a navigation-safe send task.
 * Preparation is best effort: Skip, timeout, or failure all authorize the
 * already-requested send without previews.
 */
export function prepareBackgroundLinkPreviews(
  candidates: readonly SupportedLinkPreview[],
  timeoutMs = POST_SUBMIT_PREVIEW_BUDGET_MS,
): PreparedBackgroundLinkPreviews | null {
  const external = candidates.filter(
    (candidate) =>
      !candidate.href.startsWith("buzz://") &&
      isValidLinkPreviewSnapshotCanonicalUrl(candidate.href),
  );
  if (external.length === 0) return null;
  for (const candidate of external) {
    updateDiagnostic(candidate.href, { mode: "post-submit" });
  }

  const pending = external.some(
    (candidate) => !jobs.get(candidate.href)?.settled,
  );
  if (!pending) {
    for (const candidate of external) {
      updateDiagnostic(candidate.href, {
        terminalAt: Date.now(),
        terminalReason: "complete",
      });
    }
    return {
      promise: Promise.all(external.map(prepareLinkPreview)).then((tags) =>
        tags.filter((tag): tag is string[] => tag !== null),
      ),
      skip: () => undefined,
    };
  }

  const availableTags = () =>
    external.flatMap((candidate) => {
      const job = jobs.get(candidate.href);
      const tag = job?.resolvedTag ?? job?.fallbackTag;
      return tag ? [tag] : [];
    });
  const taskId = nextTaskId++;
  let finish: ((tags: string[][]) => void) | null = null;
  let terminal = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const complete = (
    tags: string[][],
    terminalReason: DiagnosticTerminalReason,
  ) => {
    if (terminal) return;
    terminal = true;
    if (timer !== null) clearTimeout(timer);
    tasks.delete(taskId);
    for (const candidate of external) {
      updateDiagnostic(candidate.href, {
        terminalAt: Date.now(),
        terminalReason,
      });
    }
    publishSnapshot();
    finish?.(tags);
  };
  const promise = new Promise<string[][]>((resolve) => {
    finish = resolve;
  });
  const skip = () => complete([], "skip");
  tasks.set(taskId, { id: taskId, skip });
  publishSnapshot();

  timer = setTimeout(() => complete(availableTags(), "timeout"), timeoutMs);
  void Promise.all(external.map(prepareLinkPreview)).then((tags) => {
    complete(
      tags.filter((tag): tag is string[] => tag !== null),
      "complete",
    );
  });

  return { promise, skip };
}

export function skipBackgroundLinkPreviews(): void {
  for (const task of [...tasks.values()]) task.skip();
}

export function clearLinkPreviewDiagnostics(): void {
  diagnostics.clear();
  publishSnapshot();
}

export function resetLinkPreviewPreparations(): void {
  for (const task of [...tasks.values()]) task.skip();
  jobs.clear();
  diagnostics.clear();
  publishSnapshot();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): BackgroundPreviewSnapshot {
  return snapshot;
}

export function useBackgroundLinkPreviewPreparation(): BackgroundPreviewSnapshot {
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export const __linkPreviewPreparationTest = {
  diagnostics,
  isReusableJob,
  jobs,
  reset: resetLinkPreviewPreparations,
};
