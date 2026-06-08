import type { ConnectionOptions } from "bullmq";
import type { DiscoverOptions, ToolkitConnection } from "./types";

/**
 * Normalize a connection into something BullMQ accepts. A `redis[s]://` URL is
 * parsed into host/port/password/db/tls; any non-URL value is returned as-is
 * (already a `ConnectionOptions` object or IORedis instance).
 */
export function resolveConnection(connection: ToolkitConnection): ConnectionOptions {
  if (typeof connection !== "string") return connection;
  return parseRedisUrl(connection);
}

/** Parse a `redis://[user:pass@]host[:port][/db]` (or `rediss://`) URL. */
export function parseRedisUrl(url: string): ConnectionOptions {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`bullmq-devkit: invalid redis URL "${url}"`);
  }

  const isTls = parsed.protocol === "rediss:";
  if (parsed.protocol !== "redis:" && !isTls) {
    throw new Error(`bullmq-devkit: unsupported protocol "${parsed.protocol}" (expected redis:// or rediss://)`);
  }

  const opts: Record<string, unknown> = {
    host: parsed.hostname || "127.0.0.1",
    port: parsed.port ? Number(parsed.port) : 6379,
  };
  if (parsed.username) opts.username = decodeURIComponent(parsed.username);
  if (parsed.password) opts.password = decodeURIComponent(parsed.password);

  const dbPath = parsed.pathname.replace(/^\//, "");
  if (dbPath) {
    const db = Number(dbPath);
    if (!Number.isNaN(db)) opts.db = db;
  }
  if (isTls) opts.tls = {};

  return opts as ConnectionOptions;
}

/**
 * Discover queue names by scanning Redis for `<prefix>:<name>:meta` keys. Lets
 * the CLI operate without a hand-maintained registry. Uses `SCAN` (non-blocking)
 * via a throwaway BullMQ queue's client, which is closed before returning.
 *
 * @param QueueClass The `Queue` constructor from the consumer's `bullmq`.
 */
export async function discoverQueueNames(
  QueueClass: new (name: string, opts: { connection: ConnectionOptions }) => {
    client: Promise<{ scan: (...args: any[]) => Promise<[string, string[]]> }>;
    close: () => Promise<void>;
  },
  connection: ToolkitConnection,
  options: DiscoverOptions = {},
): Promise<string[]> {
  const prefix = options.prefix ?? "bull";
  const probe = new QueueClass("__bullmq_devkit_discovery__", {
    connection: resolveConnection(connection),
  });
  try {
    const client = await probe.client;
    const match = `${prefix}:*:meta`;
    const names = new Set<string>();
    let cursor = "0";
    do {
      const [next, keys] = await client.scan(cursor, "MATCH", match, "COUNT", 200);
      cursor = next;
      for (const key of keys) {
        // key === `${prefix}:${name}:meta`; name may itself contain colons.
        const inner = key.slice(prefix.length + 1, key.length - ":meta".length);
        if (inner) names.add(inner);
      }
    } while (cursor !== "0");
    return [...names].sort();
  } finally {
    await probe.close();
  }
}
