import type { Job, Queue } from "bullmq";
import type { FailedJobInfo, FailureSummary } from "./types";

/** Predicate over a failed job. */
export type FailedJobFilter = (info: FailedJobInfo) => boolean;

const STACK_FRAMES = 5;

function firstLine(text: string | undefined): string {
  if (!text) return "(no reason recorded)";
  const line = text.split("\n")[0]?.trim();
  return line || "(no reason recorded)";
}

/** Flatten a BullMQ `Job` into a {@link FailedJobInfo}. */
export function toFailedJobInfo(job: Job): FailedJobInfo {
  const stack = Array.isArray(job.stacktrace) ? job.stacktrace.slice(0, STACK_FRAMES) : [];
  return {
    id: job.id,
    name: job.name,
    reason: firstLine(job.failedReason),
    attemptsMade: job.attemptsMade ?? 0,
    attempts: job.opts?.attempts,
    stack,
    failedAt: job.finishedOn ?? job.timestamp,
    data: job.data,
  };
}

/** Iterate every failed job in pages, yielding the raw `Job` objects. */
async function forEachFailed(
  queue: Queue,
  onJob: (job: Job) => boolean | void,
  pageSize = 100,
): Promise<void> {
  let start = 0;
  for (;;) {
    const page = await queue.getFailed(start, start + pageSize - 1);
    if (page.length === 0) return;
    for (const job of page) {
      const stop = onJob(job);
      if (stop === true) return;
    }
    if (page.length < pageSize) return;
    start += pageSize;
  }
}

/**
 * List failed (dead-letter) jobs, newest-retained first.
 * @param options.limit Max jobs to return. Default: 100.
 */
export async function listFailedJobs(
  queue: Queue,
  options: { limit?: number; filter?: FailedJobFilter } = {},
): Promise<FailedJobInfo[]> {
  const limit = options.limit ?? 100;
  const out: FailedJobInfo[] = [];
  await forEachFailed(queue, (job) => {
    const info = toFailedJobInfo(job);
    if (!options.filter || options.filter(info)) {
      out.push(info);
      if (out.length >= limit) return true;
    }
  });
  return out;
}

/**
 * Group failed jobs by their (first-line) failure reason — the fastest way to
 * see *what* is breaking. Buckets are sorted by descending count.
 * @param options.sampleSize Max failed jobs to scan. Default: 1000.
 */
export async function summarizeFailures(
  queue: Queue,
  options: { sampleSize?: number } = {},
): Promise<FailureSummary> {
  const sampleSize = options.sampleSize ?? 1000;
  const totalFailed = await queue.getFailedCount();
  const buckets = new Map<string, { count: number; sampleIds: Array<string | undefined> }>();
  let sampled = 0;

  await forEachFailed(queue, (job) => {
    const reason = firstLine(job.failedReason);
    let bucket = buckets.get(reason);
    if (!bucket) {
      bucket = { count: 0, sampleIds: [] };
      buckets.set(reason, bucket);
    }
    bucket.count++;
    if (bucket.sampleIds.length < 5) bucket.sampleIds.push(job.id);
    sampled++;
    if (sampled >= sampleSize) return true;
  });

  return {
    queue: queue.name,
    totalFailed,
    sampled,
    buckets: [...buckets.entries()]
      .map(([reason, b]) => ({ reason, count: b.count, sampleIds: b.sampleIds }))
      .sort((a, b) => b.count - a.count),
  };
}

/**
 * Re-enqueue failed jobs (`job.retry()`). Optionally filtered and capped.
 * Returns counts of what was retried vs. skipped (e.g. jobs that errored).
 */
export async function retryFailedJobs(
  queue: Queue,
  options: { limit?: number; filter?: FailedJobFilter } = {},
): Promise<{ retried: number; skipped: number; ids: Array<string | undefined> }> {
  const limit = options.limit ?? Infinity;
  const targets: Job[] = [];
  await forEachFailed(queue, (job) => {
    if (!options.filter || options.filter(toFailedJobInfo(job))) {
      targets.push(job);
      if (targets.length >= limit) return true;
    }
  });

  let retried = 0;
  let skipped = 0;
  const ids: Array<string | undefined> = [];
  for (const job of targets) {
    try {
      await job.retry("failed");
      retried++;
      ids.push(job.id);
    } catch {
      skipped++;
    }
  }
  return { retried, skipped, ids };
}

/**
 * Permanently remove failed jobs. Filter by age (`olderThanMs`) and/or a custom
 * predicate. Returns the number removed.
 */
export async function purgeFailedJobs(
  queue: Queue,
  options: { limit?: number; olderThanMs?: number; filter?: FailedJobFilter } = {},
): Promise<{ removed: number }> {
  const limit = options.limit ?? Infinity;
  const cutoff = options.olderThanMs !== undefined ? Date.now() - options.olderThanMs : undefined;
  const targets: Job[] = [];
  await forEachFailed(queue, (job) => {
    const info = toFailedJobInfo(job);
    const tooYoung = cutoff !== undefined && (info.failedAt ?? Infinity) > cutoff;
    if (tooYoung) return;
    if (!options.filter || options.filter(info)) {
      targets.push(job);
      if (targets.length >= limit) return true;
    }
  });

  let removed = 0;
  for (const job of targets) {
    try {
      await job.remove();
      removed++;
    } catch {
      /* job may have moved/expired between scan and removal */
    }
  }
  return { removed };
}

/**
 * Move failed jobs into a dedicated dead-letter queue for later inspection,
 * preserving the original name/data plus failure metadata under
 * `__deadLetter`. By default the originals are removed from the source queue.
 *
 * @example
 * ```ts
 * const dlq = new Queue("email-jobs-dead", { connection });
 * await archiveFailedJobs(emailQueue, dlq, { limit: 500 });
 * ```
 */
export async function archiveFailedJobs(
  queue: Queue,
  deadLetterQueue: Queue,
  options: { limit?: number; filter?: FailedJobFilter; remove?: boolean } = {},
): Promise<{ archived: number; removed: number }> {
  const limit = options.limit ?? Infinity;
  const remove = options.remove ?? true;
  const targets: Job[] = [];
  await forEachFailed(queue, (job) => {
    if (!options.filter || options.filter(toFailedJobInfo(job))) {
      targets.push(job);
      if (targets.length >= limit) return true;
    }
  });

  let archived = 0;
  let removed = 0;
  for (const job of targets) {
    await deadLetterQueue.add(
      job.name,
      {
        ...(job.data as Record<string, unknown>),
        __deadLetter: {
          sourceQueue: queue.name,
          originalJobId: job.id,
          failedReason: firstLine(job.failedReason),
          attemptsMade: job.attemptsMade,
          failedAt: job.finishedOn ?? job.timestamp,
        },
      },
      { removeOnComplete: false, removeOnFail: false },
    );
    archived++;
    if (remove) {
      try {
        await job.remove();
        removed++;
      } catch {
        /* ignore */
      }
    }
  }
  return { archived, removed };
}
