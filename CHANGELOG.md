# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## 0.1.0

Initial release.

- **Health** — `checkQueueHealth` / `checkQueuesHealth` with backlog, failure-rate,
  active/delayed, and paused thresholds; degraded → unhealthy escalation.
- **Metrics** — `collectQueueMetrics`, `renderPrometheus`, and a framework-agnostic
  `createMetricsHandler` exposing `bullmq_jobs` and `bullmq_queue_paused` gauges.
- **Dead-letter / failed jobs** — `listFailedJobs`, `summarizeFailures`,
  `retryFailedJobs`, `purgeFailedJobs`, `archiveFailedJobs`.
- **Retry debugging** — `inspectJob` lifecycle report with estimated next-retry time;
  `computeBackoffDelay`.
- **Cron** — dependency-free `validateCron` and `getNextRuns` (5/6-field, ranges,
  lists, steps, names; UTC).
- **CLI** — `bullmq-devkit` with `health`, `metrics`, `failed`, `retry`, `purge`,
  `inspect`, `list`, and `cron` commands, plus Redis-based queue auto-discovery.
