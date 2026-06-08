import { describe, expect, it } from "vitest";
import type { Queue } from "bullmq";
import { collectQueueMetrics, renderPrometheus } from "../src/metrics";
import type { QueueMetric } from "../src/types";

const sample: QueueMetric[] = [
  {
    queue: "email-jobs",
    paused: false,
    counts: { waiting: 5, active: 2, completed: 100, failed: 3, delayed: 1, paused: 0, waitingChildren: 0, prioritized: 0 },
  },
];

describe("renderPrometheus", () => {
  it("emits gauges with queue+state labels", () => {
    const text = renderPrometheus(sample);
    expect(text).toContain("# TYPE bullmq_jobs gauge");
    expect(text).toContain('bullmq_jobs{queue="email-jobs",state="waiting"} 5');
    expect(text).toContain('bullmq_jobs{queue="email-jobs",state="failed"} 3');
    expect(text).toContain('bullmq_queue_paused{queue="email-jobs"} 0');
    expect(text.endsWith("\n")).toBe(true);
  });

  it("applies a custom prefix and constant labels", () => {
    const text = renderPrometheus(sample, { prefix: "jobs", labels: { env: "prod" } });
    expect(text).toContain('jobs_jobs{env="prod",queue="email-jobs",state="active"} 2');
  });

  it("escapes special characters in label values", () => {
    const text = renderPrometheus(
      [{ ...sample[0]!, queue: 'we"ird' }],
      {},
    );
    expect(text).toContain('queue="we\\"ird"');
  });
});

describe("collectQueueMetrics", () => {
  it("reads counts and paused state from queues", async () => {
    const q = {
      name: "q1",
      isPaused: async () => true,
      getJobCounts: async () => ({ waiting: 7, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 }),
    } as unknown as Queue;
    const [m] = await collectQueueMetrics([q]);
    expect(m?.queue).toBe("q1");
    expect(m?.paused).toBe(true);
    expect(m?.counts.waiting).toBe(7);
  });
});
