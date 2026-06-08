import type { Job, Queue } from "bullmq";
import type { JobReport } from "./types";

type BackoffOpt = number | { type: string; delay?: number } | undefined;

/**
 * Replicate BullMQ's built-in backoff math for `fixed` and `exponential`
 * strategies, given the attempt number. Returns `undefined` for custom
 * strategies (whose delay BullMQ computes via a user function).
 */
export function computeBackoffDelay(backoff: BackoffOpt, attemptsMade: number): number | undefined {
  if (backoff === undefined) return undefined;
  if (typeof backoff === "number") return backoff;
  const delay = backoff.delay ?? 0;
  switch (backoff.type) {
    case "fixed":
      return delay;
    case "exponential":
      return Math.round(Math.pow(2, Math.max(0, attemptsMade - 1)) * delay);
    default:
      return undefined; // custom strategy
  }
}

const STACK_FRAMES = 8;

/**
 * Build a full lifecycle {@link JobReport} for one job — the go-to for retry
 * debugging. Includes state, attempt counts, the trimmed stack, timings, and an
 * *estimated* next-retry time for jobs awaiting a backoff retry.
 *
 * @throws if no job with `jobId` exists in the queue.
 *
 * @example
 * ```ts
 * const report = await inspectJob(emailQueue, "1234");
 * console.log(report.state, report.attemptsMade, "/", report.attempts, report.failedReason);
 * ```
 */
export async function inspectJob(queue: Queue, jobId: string): Promise<JobReport> {
  const job: Job | undefined = await queue.getJob(jobId);
  if (!job) {
    throw new Error(`bullmq-devkit: job "${jobId}" not found in queue "${queue.name}"`);
  }
  const state = await job.getState();

  const processedAt = job.processedOn ?? undefined;
  const finishedAt = job.finishedOn ?? undefined;
  const durationMs = processedAt && finishedAt ? finishedAt - processedAt : undefined;

  const attempts = job.opts?.attempts;
  const hasRetriesLeft = attempts !== undefined && job.attemptsMade < attempts;
  const backoffDelay = computeBackoffDelay(job.opts?.backoff as BackoffOpt, job.attemptsMade + 1);

  let nextRetryAt: number | undefined;
  if (state === "delayed" && hasRetriesLeft && backoffDelay !== undefined) {
    nextRetryAt = (finishedAt ?? Date.now()) + backoffDelay;
  }

  const stack = Array.isArray(job.stacktrace) ? job.stacktrace.slice(0, STACK_FRAMES) : [];

  return {
    id: job.id,
    name: job.name,
    queue: queue.name,
    state,
    attemptsMade: job.attemptsMade ?? 0,
    attempts,
    failedReason: job.failedReason || undefined,
    stack,
    addedAt: job.timestamp ?? undefined,
    processedAt,
    finishedAt,
    durationMs,
    delayMs: (job.opts?.delay as number | undefined) ?? backoffDelay,
    nextRetryAt,
    opts: (job.opts as Record<string, unknown>) ?? {},
    data: job.data,
  };
}
