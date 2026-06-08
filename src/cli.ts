#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createServer } from "node:http";
import { Queue } from "bullmq";
import { discoverQueueNames, resolveConnection } from "./connection";
import { checkQueueHealth } from "./health";
import { collectQueueMetrics, renderPrometheus } from "./metrics";
import { listFailedJobs, purgeFailedJobs, retryFailedJobs, summarizeFailures } from "./dlq";
import { inspectJob } from "./inspect";
import { getNextRuns, validateCron } from "./cron";
import type { FailedJobFilter } from "./dlq";
import type { HealthStatus } from "./types";

// ---- tiny ANSI helpers (respect NO_COLOR) -----------------------------------
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  cyan: (s: string) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
};
const statusColor = (s: HealthStatus) =>
  s === "healthy" ? c.green(s) : s === "degraded" ? c.yellow(s) : c.red(s);

function die(message: string): never {
  process.stderr.write(c.red(`error: ${message}`) + "\n");
  process.exit(1);
}

const HELP = `bullmq-devkit — developer toolkit for BullMQ

Usage: bullmq-devkit <command> [options]

Commands:
  health [queue...]            Health check for queues (auto-discovers if none given)
  metrics [queue...]           Print Prometheus metrics (or serve with --serve)
  failed <queue> [--summary]   List/summarize failed jobs in a queue
  retry <queue>                Retry failed jobs (--reason <substr> to filter, --limit n)
  purge <queue>                Remove failed jobs (--older-than <ms>, --reason, --limit)
  inspect <queue> <jobId>      Full lifecycle report for one job
  list                         Discover queue names from Redis
  cron <pattern>               Validate a cron pattern and show next runs

Global options:
  --redis <url>      Redis URL (or env REDIS_URL). Default: redis://127.0.0.1:6379
  --prefix <p>       BullMQ key prefix (default: bull)
  --json             Machine-readable JSON output
  -h, --help         Show this help

Examples:
  bullmq-devkit health --redis redis://localhost:6379
  bullmq-devkit metrics --serve --port 9090
  bullmq-devkit failed email-jobs --summary
  bullmq-devkit retry email-jobs --reason "ETIMEDOUT" --limit 50
  bullmq-devkit cron "*/15 * * * *"
`;

function getConnection(values: Record<string, unknown>) {
  const url = (values.redis as string) || process.env.REDIS_URL || "redis://127.0.0.1:6379";
  return resolveConnection(url);
}

async function makeQueues(names: string[], values: Record<string, unknown>): Promise<Queue[]> {
  const connection = getConnection(values);
  const prefix = (values.prefix as string) || undefined;
  return names.map((name) => new Queue(name, { connection, ...(prefix ? { prefix } : {}) }));
}

async function resolveNames(positional: string[], values: Record<string, unknown>): Promise<string[]> {
  if (positional.length > 0) return positional;
  const names = await discoverQueueNames(Queue as never, getConnection(values), {
    prefix: (values.prefix as string) || undefined,
  });
  if (names.length === 0) die("no queues found in Redis (specify queue names explicitly)");
  return names;
}

async function closeAll(queues: Queue[]): Promise<void> {
  await Promise.allSettled(queues.map((q) => q.close()));
}

function reasonFilter(reason: string | undefined): FailedJobFilter | undefined {
  if (!reason) return undefined;
  const needle = reason.toLowerCase();
  return (info) => info.reason.toLowerCase().includes(needle);
}

// ---- commands ----------------------------------------------------------------

async function cmdHealth(positional: string[], values: Record<string, unknown>) {
  const names = await resolveNames(positional, values);
  const queues = await makeQueues(names, values);
  try {
    const results = await Promise.all(queues.map((q) => checkQueueHealth(q)));
    if (values.json) {
      const worst = results.reduce<HealthStatus>(
        (a, r) => (r.status === "unhealthy" ? "unhealthy" : a === "unhealthy" ? a : r.status === "degraded" ? "degraded" : a),
        "healthy",
      );
      process.stdout.write(JSON.stringify({ status: worst, queues: results }, null, 2) + "\n");
    } else {
      for (const r of results) {
        const { counts } = r;
        process.stdout.write(
          `${statusColor(r.status).padEnd(useColor ? 18 : 9)} ${c.bold(r.queue)}  ` +
            c.dim(
              `waiting=${counts.waiting} active=${counts.active} failed=${counts.failed} ` +
                `delayed=${counts.delayed}${r.paused ? " (paused)" : ""}`,
            ) +
            "\n",
        );
      }
    }
    if (results.some((r) => r.status === "unhealthy")) process.exitCode = 2;
  } finally {
    await closeAll(queues);
  }
}

async function cmdMetrics(positional: string[], values: Record<string, unknown>) {
  const names = await resolveNames(positional, values);
  const queues = await makeQueues(names, values);
  const render = async () => renderPrometheus(await collectQueueMetrics(queues));

  if (values.serve) {
    const port = values.port ? Number(values.port) : 9090;
    const server = createServer(async (req, res) => {
      if (req.url && req.url.replace(/\/$/, "") !== "/metrics") {
        res.statusCode = 404;
        res.end("not found\n");
        return;
      }
      try {
        res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
        res.end(await render());
      } catch (err) {
        res.statusCode = 500;
        res.end(`# error: ${(err as Error).message}\n`);
      }
    });
    server.listen(port, () => {
      process.stderr.write(c.cyan(`serving metrics for ${names.length} queue(s) on http://0.0.0.0:${port}/metrics\n`));
    });
    const shutdown = async () => {
      server.close();
      await closeAll(queues);
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return; // keep process alive
  }

  try {
    process.stdout.write(await render());
  } finally {
    await closeAll(queues);
  }
}

async function cmdFailed(positional: string[], values: Record<string, unknown>) {
  const name = positional[0];
  if (!name) die("usage: bullmq-devkit failed <queue> [--summary]");
  const [queue] = await makeQueues([name], values);
  if (!queue) return;
  try {
    if (values.summary) {
      const summary = await summarizeFailures(queue, { sampleSize: Number(values.limit) || 1000 });
      if (values.json) {
        process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
      } else {
        process.stdout.write(
          c.bold(`${summary.queue}: ${summary.totalFailed} failed`) +
            c.dim(` (sampled ${summary.sampled})`) + "\n",
        );
        for (const b of summary.buckets) {
          process.stdout.write(`  ${c.red(String(b.count).padStart(6))}  ${b.reason}\n`);
        }
      }
    } else {
      const jobs = await listFailedJobs(queue, {
        limit: Number(values.limit) || 50,
        filter: reasonFilter(values.reason as string | undefined),
      });
      if (values.json) {
        process.stdout.write(JSON.stringify(jobs, null, 2) + "\n");
      } else {
        for (const j of jobs) {
          process.stdout.write(
            `${c.cyan((j.id ?? "?").padEnd(10))} ${c.dim(`${j.attemptsMade}/${j.attempts ?? "?"}`)}  ${j.reason}\n`,
          );
        }
        process.stdout.write(c.dim(`${jobs.length} shown\n`));
      }
    }
  } finally {
    await closeAll([queue]);
  }
}

async function cmdRetry(positional: string[], values: Record<string, unknown>) {
  const name = positional[0];
  if (!name) die("usage: bullmq-devkit retry <queue> [--reason <substr>] [--limit n]");
  const [queue] = await makeQueues([name], values);
  if (!queue) return;
  try {
    const res = await retryFailedJobs(queue, {
      limit: values.limit ? Number(values.limit) : undefined,
      filter: reasonFilter(values.reason as string | undefined),
    });
    process.stdout.write(
      values.json
        ? JSON.stringify(res, null, 2) + "\n"
        : c.green(`retried ${res.retried}`) + c.dim(`, skipped ${res.skipped}\n`),
    );
  } finally {
    await closeAll([queue]);
  }
}

async function cmdPurge(positional: string[], values: Record<string, unknown>) {
  const name = positional[0];
  if (!name) die("usage: bullmq-devkit purge <queue> [--older-than <ms>] [--reason <substr>] [--limit n]");
  const [queue] = await makeQueues([name], values);
  if (!queue) return;
  try {
    const res = await purgeFailedJobs(queue, {
      limit: values.limit ? Number(values.limit) : undefined,
      olderThanMs: values["older-than"] ? Number(values["older-than"]) : undefined,
      filter: reasonFilter(values.reason as string | undefined),
    });
    process.stdout.write(
      values.json ? JSON.stringify(res, null, 2) + "\n" : c.yellow(`removed ${res.removed}\n`),
    );
  } finally {
    await closeAll([queue]);
  }
}

async function cmdInspect(positional: string[], values: Record<string, unknown>) {
  const [name, jobId] = positional;
  if (!name || !jobId) die("usage: bullmq-devkit inspect <queue> <jobId>");
  const [queue] = await makeQueues([name], values);
  if (!queue) return;
  try {
    const report = await inspectJob(queue, jobId);
    if (values.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return;
    }
    const fmt = (ts: number | undefined) => (ts ? new Date(ts).toISOString() : c.dim("—"));
    process.stdout.write(
      `${c.bold(`${report.queue}#${report.id}`)} (${report.name})\n` +
        `  state     ${statusColorState(report.state)}\n` +
        `  attempts  ${report.attemptsMade}/${report.attempts ?? "?"}\n` +
        `  added     ${fmt(report.addedAt)}\n` +
        `  processed ${fmt(report.processedAt)}\n` +
        `  finished  ${fmt(report.finishedAt)}\n` +
        (report.durationMs !== undefined ? `  duration  ${report.durationMs}ms\n` : "") +
        (report.nextRetryAt ? `  next try  ${fmt(report.nextRetryAt)} ${c.dim("(est.)")}\n` : "") +
        (report.failedReason ? `  reason    ${c.red(report.failedReason)}\n` : ""),
    );
    if (report.stack.length) {
      process.stdout.write(c.dim("  stack:\n"));
      for (const line of report.stack) process.stdout.write(c.dim(`    ${line.split("\n")[0]}\n`));
    }
  } finally {
    await closeAll([queue]);
  }
}

function statusColorState(state: string): string {
  if (state === "completed") return c.green(state);
  if (state === "failed") return c.red(state);
  if (state === "active") return c.cyan(state);
  return c.yellow(state);
}

async function cmdList(_positional: string[], values: Record<string, unknown>) {
  const names = await discoverQueueNames(Queue as never, getConnection(values), {
    prefix: (values.prefix as string) || undefined,
  });
  process.stdout.write(values.json ? JSON.stringify(names, null, 2) + "\n" : names.join("\n") + "\n");
}

function cmdCron(positional: string[], values: Record<string, unknown>) {
  const pattern = positional.join(" ").trim();
  if (!pattern) die('usage: bullmq-devkit cron "<pattern>"');
  const result = validateCron(pattern);
  if (values.json) {
    const next = result.valid ? getNextRuns(pattern, { count: Number(values.count) || 5 }).map((d) => d.toISOString()) : [];
    process.stdout.write(JSON.stringify({ ...result, nextRuns: next }, null, 2) + "\n");
    if (!result.valid) process.exitCode = 1;
    return;
  }
  if (!result.valid) {
    process.stdout.write(c.red(`invalid: ${pattern}\n`));
    for (const e of result.errors) process.stdout.write(`  ${c.red("✗")} ${e}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(c.green(`valid: ${pattern}`) + c.dim(` (${result.fieldCount} fields)\n`));
  for (const w of result.warnings) process.stdout.write(`  ${c.yellow("!")} ${w}\n`);
  const next = getNextRuns(pattern, { count: Number(values.count) || 5 });
  process.stdout.write(c.dim("  next runs (UTC):\n"));
  for (const d of next) process.stdout.write(`    ${d.toISOString()}\n`);
  if (next.length === 0) process.stdout.write(c.yellow("    (never fires within 5 years)\n"));
}

// ---- entrypoint --------------------------------------------------------------

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      redis: { type: "string" },
      prefix: { type: "string" },
      json: { type: "boolean", default: false },
      summary: { type: "boolean", default: false },
      serve: { type: "boolean", default: false },
      port: { type: "string" },
      reason: { type: "string" },
      limit: { type: "string" },
      count: { type: "string" },
      "older-than": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const [command, ...rest] = positionals;
  if (values.help || !command) {
    process.stdout.write(HELP);
    return;
  }

  switch (command) {
    case "health": return cmdHealth(rest, values);
    case "metrics": return cmdMetrics(rest, values);
    case "failed": return cmdFailed(rest, values);
    case "retry": return cmdRetry(rest, values);
    case "purge": return cmdPurge(rest, values);
    case "inspect": return cmdInspect(rest, values);
    case "list": return cmdList(rest, values);
    case "cron": return cmdCron(rest, values);
    default:
      die(`unknown command "${command}". Run with --help for usage.`);
  }
}

main().catch((err) => die((err as Error).message));
