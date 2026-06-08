import type { Queue } from "bullmq";
import type { HealthCheckEntry, HealthCheckResult, HealthStatus, HealthThresholds, JobCounts } from "./types";

const COUNT_TYPES = [
  "waiting",
  "active",
  "completed",
  "failed",
  "delayed",
  "paused",
  "waiting-children",
  "prioritized",
] as const;

/** Fetch normalized {@link JobCounts} for a queue. */
export async function getJobCounts(queue: Queue): Promise<JobCounts> {
  const raw = await queue.getJobCounts(...COUNT_TYPES);
  return {
    waiting: raw.waiting ?? 0,
    active: raw.active ?? 0,
    completed: raw.completed ?? 0,
    failed: raw.failed ?? 0,
    delayed: raw.delayed ?? 0,
    paused: raw.paused ?? 0,
    waitingChildren: raw["waiting-children"] ?? 0,
    prioritized: raw.prioritized ?? 0,
  };
}

const STATUS_RANK: Record<HealthStatus, number> = { healthy: 0, degraded: 1, unhealthy: 2 };

function worst(a: HealthStatus, b: HealthStatus): HealthStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

/**
 * Evaluate a metric against a threshold. Returns `degraded` once the value meets
 * the threshold and `unhealthy` at 2× the threshold (a clearly-blown budget).
 */
function evaluate(name: string, value: number, threshold: number | undefined): HealthCheckEntry {
  if (threshold === undefined) {
    return { name, status: "healthy", value, message: `${name}=${value} (no threshold)` };
  }
  let status: HealthStatus = "healthy";
  if (value >= threshold * 2) status = "unhealthy";
  else if (value >= threshold) status = "degraded";
  return {
    name,
    status,
    value,
    threshold,
    message:
      status === "healthy"
        ? `${name}=${value} within threshold ${threshold}`
        : `${name}=${value} ${status === "unhealthy" ? "far exceeds" : "exceeds"} threshold ${threshold}`,
  };
}

/**
 * Check the health of a single queue against {@link HealthThresholds}.
 *
 * The overall `status` is the worst of every individual check. With no
 * thresholds supplied, a queue is `healthy` unless paused (`degraded`, or
 * `unhealthy` when `failOnPaused` is set).
 *
 * @example
 * ```ts
 * const h = await checkQueueHealth(emailQueue, { maxWaiting: 1000, maxFailedRatio: 0.1 });
 * if (h.status !== "healthy") console.error(h.checks);
 * ```
 */
export async function checkQueueHealth(
  queue: Queue,
  thresholds: HealthThresholds = {},
): Promise<HealthCheckResult> {
  const [counts, paused] = await Promise.all([getJobCounts(queue), queue.isPaused()]);

  const terminal = counts.completed + counts.failed;
  const failedRatio = terminal > 0 ? counts.failed / terminal : 0;

  const checks: HealthCheckEntry[] = [
    evaluate("waiting", counts.waiting, thresholds.maxWaiting),
    evaluate("failed", counts.failed, thresholds.maxFailed),
    evaluate("active", counts.active, thresholds.maxActive),
    evaluate("delayed", counts.delayed, thresholds.maxDelayed),
  ];

  if (thresholds.maxFailedRatio !== undefined && terminal > 0) {
    const r = thresholds.maxFailedRatio;
    const pct = Math.round(failedRatio * 1000) / 10;
    let status: HealthStatus = "healthy";
    if (failedRatio >= Math.min(r * 2, 1)) status = "unhealthy";
    else if (failedRatio >= r) status = "degraded";
    checks.push({
      name: "failedRatio",
      status,
      value: failedRatio,
      threshold: r,
      message:
        status === "healthy"
          ? `failure rate ${pct}% within ${Math.round(r * 1000) / 10}%`
          : `failure rate ${pct}% exceeds ${Math.round(r * 1000) / 10}%`,
    });
  }

  if (paused) {
    const status: HealthStatus = thresholds.failOnPaused ? "unhealthy" : "degraded";
    checks.push({ name: "paused", status, value: 1, message: "queue is paused" });
  }

  const overall = checks.reduce<HealthStatus>((acc, c) => worst(acc, c.status), "healthy");
  // Surface the most severe checks first.
  checks.sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status]);

  return {
    queue: queue.name,
    status: overall,
    paused,
    counts,
    failedRatio,
    checks,
    checkedAt: new Date().toISOString(),
  };
}

/** Check several queues. Returns one result per queue plus a rolled-up `status`. */
export async function checkQueuesHealth(
  queues: Queue[],
  thresholds: HealthThresholds = {},
): Promise<{ status: HealthStatus; queues: HealthCheckResult[] }> {
  const results = await Promise.all(queues.map((q) => checkQueueHealth(q, thresholds)));
  const status = results.reduce<HealthStatus>((acc, r) => worst(acc, r.status), "healthy");
  return { status, queues: results };
}
