import type { Queue } from "bullmq";
import { getJobCounts } from "./health";
import type { JobCounts, MetricsOptions, QueueMetric } from "./types";

/** Gather current counts + paused flag for each queue. */
export async function collectQueueMetrics(queues: Queue[]): Promise<QueueMetric[]> {
  return Promise.all(
    queues.map(async (queue) => ({
      queue: queue.name,
      paused: await queue.isPaused(),
      counts: await getJobCounts(queue),
    })),
  );
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return `{${entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",")}}`;
}

const STATE_KEYS: Array<[keyof JobCounts, string]> = [
  ["waiting", "waiting"],
  ["active", "active"],
  ["completed", "completed"],
  ["failed", "failed"],
  ["delayed", "delayed"],
  ["paused", "paused"],
  ["waitingChildren", "waiting-children"],
  ["prioritized", "prioritized"],
];

/**
 * Render metrics in the Prometheus text exposition format. Emits a
 * `<prefix>_jobs` gauge labelled by `queue` and `state`, and a
 * `<prefix>_queue_paused` gauge.
 *
 * @example
 * ```ts
 * const text = renderPrometheus(await collectQueueMetrics(queues), { labels: { env: "prod" } });
 * res.setHeader("Content-Type", "text/plain; version=0.0.4");
 * res.end(text);
 * ```
 */
export function renderPrometheus(metrics: QueueMetric[], options: MetricsOptions = {}): string {
  const prefix = options.prefix ?? "bullmq";
  const constLabels = options.labels ?? {};
  const lines: string[] = [];

  const jobsMetric = `${prefix}_jobs`;
  lines.push(`# HELP ${jobsMetric} Number of jobs in a BullMQ queue by state.`);
  lines.push(`# TYPE ${jobsMetric} gauge`);
  for (const m of metrics) {
    for (const [key, state] of STATE_KEYS) {
      const labels = formatLabels({ ...constLabels, queue: m.queue, state });
      lines.push(`${jobsMetric}${labels} ${m.counts[key]}`);
    }
  }

  const pausedMetric = `${prefix}_queue_paused`;
  lines.push(`# HELP ${pausedMetric} Whether the queue is paused (1) or running (0).`);
  lines.push(`# TYPE ${pausedMetric} gauge`);
  for (const m of metrics) {
    const labels = formatLabels({ ...constLabels, queue: m.queue });
    lines.push(`${pausedMetric}${labels} ${m.paused ? 1 : 0}`);
  }

  return lines.join("\n") + "\n";
}

/** Minimal response shape shared by Node's `http` and Express. */
interface ResponseLike {
  statusCode?: number;
  setHeader(name: string, value: string): void;
  end(chunk?: string): void;
}

/**
 * Build a framework-agnostic `/metrics` request handler. Works as a Node
 * `http` listener and as an Express middleware.
 *
 * @example
 * ```ts
 * app.get("/metrics", createMetricsHandler(queues, { labels: { env: "prod" } }));
 * ```
 */
export function createMetricsHandler(queues: Queue[], options: MetricsOptions = {}) {
  return async function metricsHandler(_req: unknown, res: ResponseLike): Promise<void> {
    try {
      const text = renderPrometheus(await collectQueueMetrics(queues), options);
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      res.end(text);
    } catch (err) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(`# error collecting metrics: ${(err as Error).message}\n`);
    }
  };
}
