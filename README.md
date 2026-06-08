# bullmq-devkit

A **zero-dependency developer toolkit for [BullMQ](https://docs.bullmq.io/)** — the things you reach for when a queue misbehaves in production:

- 🩺 **Health checks** — backlog / failure-rate / paused thresholds, with a rolled-up status
- 📈 **Prometheus metrics** — job counts per state, ready to scrape
- ☠️ **Dead-letter / failed-job management** — list, summarize, retry, purge, archive
- 🔍 **Retry debugging** — a full lifecycle report for any job, incl. estimated next-retry time
- ⏰ **Cron validation** — validate BullMQ repeatable patterns and preview the next runs

Works against **any** existing BullMQ setup — no need to adopt a framework or change how you create queues. Ships a library **and** a CLI. The only runtime peer dependency is `bullmq` itself.

```bash
npm install bullmq-devkit
# bullmq is a peer dependency — install it if you haven't:
npm install bullmq
```

> Requires Node ≥ 18 and BullMQ ≥ 4. ESM + CJS, fully typed.

---

## CLI

The CLI auto-discovers your queues from Redis (by scanning `bull:*:meta` keys), so most commands work with zero config.

```bash
# Health of every queue in Redis
npx bullmq-devkit health --redis redis://localhost:6379

# Serve Prometheus metrics for scraping
npx bullmq-devkit metrics --serve --port 9090

# What's failing, grouped by reason?
npx bullmq-devkit failed email-jobs --summary

# Retry everything that failed with a timeout (cap at 50)
npx bullmq-devkit retry email-jobs --reason ETIMEDOUT --limit 50

# Remove failed jobs older than an hour
npx bullmq-devkit purge email-jobs --older-than 3600000

# Full report for one job
npx bullmq-devkit inspect email-jobs 1234

# List discovered queues
npx bullmq-devkit list

# Validate a cron pattern and preview the next runs
npx bullmq-devkit cron "*/15 * * * *"
```

Global flags: `--redis <url>` (or `REDIS_URL` env, default `redis://127.0.0.1:6379`), `--prefix <p>` (BullMQ key prefix, default `bull`), `--json` (machine-readable output). `health` exits non-zero when any queue is `unhealthy`, and `cron` exits non-zero on an invalid pattern — handy in CI.

---

## Library

Every function takes the **`Queue` instances you already have** — pass yours in.

### Health checks

```ts
import { Queue } from "bullmq";
import { checkQueueHealth, checkQueuesHealth } from "bullmq-devkit";

const email = new Queue("email-jobs", { connection });

const h = await checkQueueHealth(email, {
  maxWaiting: 1000,      // backlog
  maxFailedRatio: 0.1,   // 10% failure rate
  maxActive: 200,
  failOnPaused: true,
});

// h.status: "healthy" | "degraded" | "unhealthy"
// h.checks: per-threshold breakdown (worst-first)
if (h.status !== "healthy") console.error(h.checks);

// Roll several queues into one status (e.g. a /healthz endpoint)
const overall = await checkQueuesHealth([email, sms, push], { maxWaiting: 5000 });
res.status(overall.status === "unhealthy" ? 503 : 200).json(overall);
```

A breach is `degraded` at the threshold and escalates to `unhealthy` at 2× it.

### Prometheus metrics

```ts
import { createMetricsHandler } from "bullmq-devkit";

// Express / any (req, res) framework
app.get("/metrics", createMetricsHandler([email, sms, push], { labels: { env: "prod" } }));
```

Exposes `bullmq_jobs{queue,state}` and `bullmq_queue_paused{queue}` gauges. Or render the text yourself:

```ts
import { collectQueueMetrics, renderPrometheus } from "bullmq-devkit";
const text = renderPrometheus(await collectQueueMetrics(queues));
```

### Dead-letter / failed-job management

In BullMQ the `failed` set *is* the dead-letter queue. These helpers make it manageable:

```ts
import {
  listFailedJobs,
  summarizeFailures,
  retryFailedJobs,
  purgeFailedJobs,
  archiveFailedJobs,
} from "bullmq-devkit";

// What's broken, at a glance — grouped by failure reason
const summary = await summarizeFailures(email);
// → { totalFailed, buckets: [{ reason, count, sampleIds }, ...] }

// Bulk retry, filtered
await retryFailedJobs(email, { filter: (j) => j.reason.includes("ETIMEDOUT"), limit: 100 });

// Clean up old noise
await purgeFailedJobs(email, { olderThanMs: 24 * 60 * 60 * 1000 });

// Move failures into a dedicated dead-letter queue for later triage
const dlq = new Queue("email-jobs-dead", { connection });
await archiveFailedJobs(email, dlq, { limit: 500 });
```

### Retry debugging

```ts
import { inspectJob } from "bullmq-devkit";

const report = await inspectJob(email, "1234");
// report.state, report.attemptsMade / report.attempts,
// report.failedReason, report.stack,
// report.processedAt / report.finishedAt / report.durationMs,
// report.nextRetryAt  ← estimated from the job's backoff strategy
```

### Cron validation

```ts
import { validateCron, getNextRuns } from "bullmq-devkit";

const v = validateCron("*/15 * * * *");
// { valid: true, fieldCount: 5, hasSeconds: false, warnings: [], fields: [...] }

validateCron("0 0 31 2 *").warnings;
// ["the day-of-month never occurs in the selected month(s) — this schedule will never fire"]

getNextRuns("0 9 * * 1", { count: 3 });
// → next three Monday 09:00 runs (UTC)
```

Supports 5-field (`m h dom mon dow`) and 6-field (seconds-first) patterns, ranges, lists, steps, and month/day names. `?` is treated as `*`. Times are computed in **UTC**.

---

## API reference

| Function | Description |
| --- | --- |
| `checkQueueHealth(queue, thresholds?)` | Health of one queue. |
| `checkQueuesHealth(queues, thresholds?)` | Health of many + rolled-up status. |
| `getJobCounts(queue)` | Normalized job counts. |
| `collectQueueMetrics(queues)` | Counts + paused flag per queue. |
| `renderPrometheus(metrics, opts?)` | Prometheus text exposition. |
| `createMetricsHandler(queues, opts?)` | `(req, res)` handler for `/metrics`. |
| `listFailedJobs(queue, opts?)` | Failed jobs, flattened. |
| `summarizeFailures(queue, opts?)` | Failures grouped by reason. |
| `retryFailedJobs(queue, opts?)` | Bulk retry, filterable. |
| `purgeFailedJobs(queue, opts?)` | Remove failed jobs (by age/filter). |
| `archiveFailedJobs(queue, dlq, opts?)` | Move failures to a dead-letter queue. |
| `inspectJob(queue, jobId)` | Full lifecycle report. |
| `computeBackoffDelay(backoff, attempt)` | BullMQ backoff math. |
| `validateCron(pattern)` | Validate; never throws. |
| `getNextRuns(pattern, opts?)` | Next N run times (UTC). |
| `discoverQueueNames(Queue, connection, opts?)` | Scan Redis for queue names. |
| `parseRedisUrl(url)` / `resolveConnection(conn)` | Connection helpers. |

## Notes & caveats

- `completed`/`failed` counts reflect only **retained** jobs — most queues trim them via `removeOnComplete`/`removeOnFail`, so `failedRatio` is a recent-window estimate, not a lifetime rate.
- Cron next-run times are computed in **UTC**; time-zone handling is not included.
- `archiveFailedJobs` copies job `data` plus a `__deadLetter` metadata block into the target queue.

## License

MIT
