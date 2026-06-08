import { describe, expect, it } from "vitest";
import type { Queue } from "bullmq";
import { checkQueueHealth, checkQueuesHealth } from "../src/health";

function fakeQueue(name: string, counts: Record<string, number>, paused = false): Queue {
  return {
    name,
    getJobCounts: async () => counts,
    isPaused: async () => paused,
  } as unknown as Queue;
}

describe("checkQueueHealth", () => {
  it("is healthy with no thresholds and no failures", async () => {
    const q = fakeQueue("email-jobs", { waiting: 3, active: 1, completed: 100, failed: 0, delayed: 0, paused: 0 });
    const h = await checkQueueHealth(q);
    expect(h.status).toBe("healthy");
    expect(h.queue).toBe("email-jobs");
    expect(h.counts.waiting).toBe(3);
  });

  it("flags degraded when waiting exceeds the threshold", async () => {
    const q = fakeQueue("n", { waiting: 1200, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 });
    const h = await checkQueueHealth(q, { maxWaiting: 1000 });
    expect(h.status).toBe("degraded");
    expect(h.checks[0]?.name).toBe("waiting");
  });

  it("escalates to unhealthy at 2x the threshold", async () => {
    const q = fakeQueue("n", { waiting: 2500, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 });
    const h = await checkQueueHealth(q, { maxWaiting: 1000 });
    expect(h.status).toBe("unhealthy");
  });

  it("computes the failure ratio and checks it", async () => {
    const q = fakeQueue("n", { waiting: 0, active: 0, completed: 80, failed: 20, delayed: 0, paused: 0 });
    const h = await checkQueueHealth(q, { maxFailedRatio: 0.1 });
    expect(h.failedRatio).toBeCloseTo(0.2);
    expect(h.status).toBe("unhealthy"); // 0.2 >= 0.1 * 2
  });

  it("reports paused queues as degraded by default and unhealthy when failOnPaused", async () => {
    const counts = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 };
    expect((await checkQueueHealth(fakeQueue("n", counts, true))).status).toBe("degraded");
    expect((await checkQueueHealth(fakeQueue("n", counts, true), { failOnPaused: true })).status).toBe("unhealthy");
  });
});

describe("checkQueuesHealth", () => {
  it("rolls up to the worst status", async () => {
    const ok = fakeQueue("a", { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 });
    const bad = fakeQueue("b", { waiting: 5000, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 });
    const res = await checkQueuesHealth([ok, bad], { maxWaiting: 1000 });
    expect(res.status).toBe("unhealthy");
    expect(res.queues).toHaveLength(2);
  });
});
