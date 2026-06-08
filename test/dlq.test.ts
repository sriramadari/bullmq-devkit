import { describe, expect, it } from "vitest";
import type { Job, Queue } from "bullmq";
import { listFailedJobs, purgeFailedJobs, retryFailedJobs, summarizeFailures, toFailedJobInfo } from "../src/dlq";

interface FakeJob {
  id: string;
  name: string;
  data: unknown;
  failedReason: string;
  stacktrace: string[];
  attemptsMade: number;
  opts: { attempts?: number };
  finishedOn: number;
  timestamp: number;
  retried?: boolean;
  removed?: boolean;
}

function makeJob(id: string, reason: string, overrides: Partial<FakeJob> = {}): FakeJob {
  return {
    id,
    name: "job",
    data: { id },
    failedReason: reason,
    stacktrace: [`Error: ${reason}\n  at foo`, "  at bar"],
    attemptsMade: 3,
    opts: { attempts: 3 },
    finishedOn: 1_000_000,
    timestamp: 900_000,
    ...overrides,
  };
}

function fakeQueue(jobs: FakeJob[]): Queue & { jobs: FakeJob[] } {
  const q = {
    name: "dead-jobs",
    jobs,
    getFailedCount: async () => jobs.length,
    getFailed: async (start: number, end: number) =>
      jobs.slice(start, end + 1).map((j) => ({
        ...j,
        retry: async () => {
          j.retried = true;
        },
        remove: async () => {
          j.removed = true;
        },
      })) as unknown as Job[],
  };
  return q as unknown as Queue & { jobs: FakeJob[] };
}

describe("toFailedJobInfo", () => {
  it("flattens a job and trims the reason to one line", () => {
    const info = toFailedJobInfo(makeJob("1", "ETIMEDOUT: connect timed out\nstack...") as unknown as Job);
    expect(info.id).toBe("1");
    expect(info.reason).toBe("ETIMEDOUT: connect timed out");
    expect(info.attempts).toBe(3);
    expect(info.stack.length).toBeGreaterThan(0);
  });
});

describe("listFailedJobs", () => {
  it("respects the limit and paginates", async () => {
    const jobs = Array.from({ length: 250 }, (_, i) => makeJob(String(i), "boom"));
    const list = await listFailedJobs(fakeQueue(jobs), { limit: 120 });
    expect(list).toHaveLength(120);
    expect(list[0]?.id).toBe("0");
  });

  it("filters by reason", async () => {
    const jobs = [makeJob("1", "ETIMEDOUT"), makeJob("2", "ECONNREFUSED"), makeJob("3", "ETIMEDOUT")];
    const list = await listFailedJobs(fakeQueue(jobs), {
      filter: (i) => i.reason.includes("ETIMEDOUT"),
    });
    expect(list.map((j) => j.id)).toEqual(["1", "3"]);
  });
});

describe("summarizeFailures", () => {
  it("buckets by reason, sorted by count", async () => {
    const jobs = [
      makeJob("1", "ETIMEDOUT"),
      makeJob("2", "ETIMEDOUT"),
      makeJob("3", "ETIMEDOUT"),
      makeJob("4", "ECONNREFUSED"),
    ];
    const s = await summarizeFailures(fakeQueue(jobs));
    expect(s.totalFailed).toBe(4);
    expect(s.buckets[0]).toMatchObject({ reason: "ETIMEDOUT", count: 3 });
    expect(s.buckets[1]).toMatchObject({ reason: "ECONNREFUSED", count: 1 });
  });
});

describe("retryFailedJobs", () => {
  it("retries matching jobs and reports counts", async () => {
    const jobs = [makeJob("1", "ETIMEDOUT"), makeJob("2", "ECONNREFUSED")];
    const q = fakeQueue(jobs);
    const res = await retryFailedJobs(q, { filter: (i) => i.reason === "ETIMEDOUT" });
    expect(res.retried).toBe(1);
    expect(res.ids).toEqual(["1"]);
  });
});

describe("purgeFailedJobs", () => {
  it("removes jobs older than the cutoff", async () => {
    const old = makeJob("old", "boom", { finishedOn: 1000 });
    const recent = makeJob("recent", "boom", { finishedOn: Date.now() });
    const q = fakeQueue([old, recent]);
    const res = await purgeFailedJobs(q, { olderThanMs: 60_000 });
    expect(res.removed).toBe(1);
    expect(old.removed).toBe(true);
    expect(recent.removed).toBeUndefined();
  });
});
