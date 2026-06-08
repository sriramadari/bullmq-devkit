import type { ConnectionOptions } from "bullmq";

/** Minimal logger contract. `console` satisfies it, as do Pino/Winston. */
export interface Logger {
  info(message: string): void;
  error(message: string | Error): void;
  warn?(message: string): void;
  debug?(message: string): void;
}

/**
 * Point-in-time job counts for a queue. Keys mirror BullMQ job states.
 * `completed`/`failed` reflect only what is still retained (queues commonly
 * trim them via `removeOnComplete`/`removeOnFail`), so treat them as recent
 * volume rather than lifetime totals.
 */
export interface JobCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
  waitingChildren: number;
  prioritized: number;
}

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

/**
 * Thresholds for {@link checkQueueHealth}. Any omitted threshold is not checked.
 * A `degraded`-level breach is escalated to `unhealthy` at 2× the threshold.
 */
export interface HealthThresholds {
  /** Backlog: number of jobs in the `waiting` state. */
  maxWaiting?: number;
  /** Number of retained `failed` jobs. */
  maxFailed?: number;
  /** failed / (completed + failed), in [0,1]. Ignored when no terminal jobs are retained. */
  maxFailedRatio?: number;
  /** Number of `active` (in-flight) jobs — a high value can indicate stuck workers. */
  maxActive?: number;
  /** Number of `delayed` jobs (scheduled / awaiting backoff). */
  maxDelayed?: number;
  /** If true, a paused queue is reported as `unhealthy`. Default: false (reported as `degraded`). */
  failOnPaused?: boolean;
}

/** Result of a single threshold evaluation. */
export interface HealthCheckEntry {
  name: string;
  status: HealthStatus;
  message: string;
  value: number;
  threshold?: number;
}

/** Aggregate health of one queue. */
export interface HealthCheckResult {
  queue: string;
  status: HealthStatus;
  paused: boolean;
  counts: JobCounts;
  /** failed / (completed + failed); 0 when no terminal jobs are retained. */
  failedRatio: number;
  /** Per-threshold breakdown, worst-first. */
  checks: HealthCheckEntry[];
  checkedAt: string;
}

/** A failed job, flattened for inspection. */
export interface FailedJobInfo {
  id: string | undefined;
  name: string;
  /** First line of `failedReason`. */
  reason: string;
  attemptsMade: number;
  /** Configured max attempts (`opts.attempts`), if any. */
  attempts: number | undefined;
  /** Most-recent stack trace, trimmed to a handful of frames. */
  stack: string[];
  failedAt: number | undefined;
  data: unknown;
}

/** One bucket of {@link summarizeFailures}. */
export interface FailureBucket {
  reason: string;
  count: number;
  /** Representative job ids (capped). */
  sampleIds: Array<string | undefined>;
}

export interface FailureSummary {
  queue: string;
  totalFailed: number;
  /** Number of failed jobs actually scanned (<= totalFailed). */
  sampled: number;
  /** Buckets sorted by descending count. */
  buckets: FailureBucket[];
}

/** Full lifecycle report for one job, used for retry debugging. */
export interface JobReport {
  id: string | undefined;
  name: string;
  queue: string;
  state: string;
  attemptsMade: number;
  attempts: number | undefined;
  failedReason: string | undefined;
  stack: string[];
  /** ms timestamps. */
  addedAt: number | undefined;
  processedAt: number | undefined;
  finishedAt: number | undefined;
  /** finishedAt - processedAt, ms. */
  durationMs: number | undefined;
  /** Configured delay / next backoff delay, ms. */
  delayMs: number | undefined;
  /** Estimated time of the next retry attempt, if one is pending. */
  nextRetryAt: number | undefined;
  opts: Record<string, unknown>;
  data: unknown;
}

/** Prometheus sample produced by {@link collectQueueMetrics}. */
export interface QueueMetric {
  queue: string;
  paused: boolean;
  counts: JobCounts;
}

export interface MetricsOptions {
  /** Metric name prefix. Default: `bullmq`. */
  prefix?: string;
  /** Extra constant labels applied to every series, e.g. `{ env: "prod" }`. */
  labels?: Record<string, string>;
}

export interface DiscoverOptions {
  /** BullMQ key prefix. Default: `bull`. */
  prefix?: string;
}

/** A redis connection: anything BullMQ accepts, or a `redis://` URL string. */
export type ToolkitConnection = ConnectionOptions | string;
