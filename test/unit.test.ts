import { describe, expect, it } from "vitest";
import type { Job, Queue } from "bullmq";
import { parseRedisUrl } from "../src/connection";
import { computeBackoffDelay, inspectJob } from "../src/inspect";

describe("parseRedisUrl", () => {
  it("parses host, port, password and db", () => {
    const opts = parseRedisUrl("redis://:s3cret@cache.example.com:6380/2") as Record<string, unknown>;
    expect(opts.host).toBe("cache.example.com");
    expect(opts.port).toBe(6380);
    expect(opts.password).toBe("s3cret");
    expect(opts.db).toBe(2);
  });

  it("defaults host/port and enables tls for rediss://", () => {
    const opts = parseRedisUrl("rediss://secure-host") as Record<string, unknown>;
    expect(opts.host).toBe("secure-host");
    expect(opts.port).toBe(6379);
    expect(opts.tls).toEqual({});
  });

  it("throws on a bad protocol or malformed URL", () => {
    expect(() => parseRedisUrl("http://x")).toThrow(/unsupported protocol/);
    expect(() => parseRedisUrl("not a url")).toThrow(/invalid redis URL/);
  });
});

describe("computeBackoffDelay", () => {
  it("handles numeric, fixed and exponential strategies", () => {
    expect(computeBackoffDelay(5000, 3)).toBe(5000);
    expect(computeBackoffDelay({ type: "fixed", delay: 2000 }, 4)).toBe(2000);
    expect(computeBackoffDelay({ type: "exponential", delay: 1000 }, 1)).toBe(1000);
    expect(computeBackoffDelay({ type: "exponential", delay: 1000 }, 3)).toBe(4000);
    expect(computeBackoffDelay({ type: "custom" }, 2)).toBeUndefined();
    expect(computeBackoffDelay(undefined, 1)).toBeUndefined();
  });
});

describe("inspectJob", () => {
  function fakeQueue(job: Partial<Record<string, unknown>> | undefined): Queue {
    return {
      name: "email-jobs",
      getJob: async () => (job ? ({ ...job, getState: async () => job.state ?? "failed" } as unknown as Job) : undefined),
    } as unknown as Queue;
  }

  it("builds a report with duration and estimated next retry", async () => {
    const q = fakeQueue({
      id: "42",
      name: "send",
      state: "delayed",
      attemptsMade: 1,
      failedReason: "ETIMEDOUT",
      stacktrace: ["Error: ETIMEDOUT\n at x"],
      timestamp: 1000,
      processedOn: 2000,
      finishedOn: 2500,
      opts: { attempts: 3, backoff: { type: "exponential", delay: 1000 } },
      data: {},
    });
    const r = await inspectJob(q, "42");
    expect(r.id).toBe("42");
    expect(r.durationMs).toBe(500);
    // attemptsMade=1, next attempt=2 -> exponential 2^1*1000 = 2000ms after finishedOn
    expect(r.nextRetryAt).toBe(2500 + 2000);
  });

  it("throws when the job is missing", async () => {
    await expect(inspectJob(fakeQueue(undefined), "nope")).rejects.toThrow(/not found/);
  });
});
