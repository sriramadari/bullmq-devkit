/**
 * A small, dependency-free cron parser/validator for BullMQ repeatable jobs.
 *
 * Supports standard 5-field (`m h dom mon dow`) and 6-field (`s m h dom mon dow`,
 * seconds first) patterns with `*`, ranges (`a-b`), lists (`a,b`), steps
 * (`*​/n`, `a-b/n`), and month/day names. `?` is accepted as an alias for `*`.
 * Step/range edge cases produce errors; non-standard extensions (`L`, `W`, `#`)
 * produce a clear "unsupported" error. All times are computed in **UTC**.
 */

export interface CronField {
  name: string;
  /** Sorted, de-duplicated list of matching values. */
  values: number[];
  /** True when the field was `*` or `?` (unrestricted). */
  wildcard: boolean;
}

export interface CronValidationResult {
  valid: boolean;
  pattern: string;
  fieldCount: number;
  hasSeconds: boolean;
  errors: string[];
  warnings: string[];
  /** Populated only when `valid`. */
  fields?: CronField[];
}

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: Record<string, number>;
  /** Map an out-of-band alias onto a canonical value (e.g. dow 7 -> 0). */
  alias?: (n: number) => number;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const DAYS: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

const FIELD_SPECS_5: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS },
  { name: "day-of-week", min: 0, max: 7, names: DAYS, alias: (n) => (n === 7 ? 0 : n) },
];
const SECOND_SPEC: FieldSpec = { name: "second", min: 0, max: 59 };

class CronError extends Error {}

function resolveToken(token: string, spec: FieldSpec): number {
  const lower = token.toLowerCase();
  if (spec.names && lower in spec.names) return spec.names[lower] as number;
  if (!/^\d+$/.test(token)) {
    throw new CronError(`${spec.name}: "${token}" is not a valid value`);
  }
  return Number(token);
}

function parseField(raw: string, spec: FieldSpec): CronField {
  if (/[LW#]/i.test(raw)) {
    throw new CronError(`${spec.name}: unsupported syntax "${raw}" (L/W/# are not supported)`);
  }

  const wildcard = raw === "*" || raw === "?";
  const set = new Set<number>();

  for (const part of raw.split(",")) {
    if (part === "") throw new CronError(`${spec.name}: empty list item in "${raw}"`);

    let range = part;
    let step = 1;
    const slash = part.indexOf("/");
    if (slash !== -1) {
      range = part.slice(0, slash);
      const stepStr = part.slice(slash + 1);
      if (!/^\d+$/.test(stepStr) || Number(stepStr) === 0) {
        throw new CronError(`${spec.name}: invalid step "${stepStr}" in "${part}"`);
      }
      step = Number(stepStr);
    }

    let lo: number;
    let hi: number;
    if (range === "*" || range === "?") {
      lo = spec.min;
      hi = spec.max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      if (a === undefined || b === undefined || a === "" || b === "") {
        throw new CronError(`${spec.name}: malformed range "${range}"`);
      }
      lo = spec.alias ? spec.alias(resolveToken(a, spec)) : resolveToken(a, spec);
      hi = spec.alias ? spec.alias(resolveToken(b, spec)) : resolveToken(b, spec);
    } else {
      const v = spec.alias ? spec.alias(resolveToken(range, spec)) : resolveToken(range, spec);
      lo = v;
      hi = slash !== -1 ? spec.max : v; // `a/n` means "from a to max, every n"
    }

    if (lo < spec.min || hi > spec.max) {
      throw new CronError(
        `${spec.name}: value out of range ${spec.min}-${spec.max} in "${part}"`,
      );
    }
    if (lo > hi) {
      throw new CronError(`${spec.name}: range start ${lo} is after end ${hi} in "${part}"`);
    }
    for (let i = lo; i <= hi; i += step) {
      set.add(spec.alias ? spec.alias(i) : i);
    }
  }

  return { name: spec.name, values: [...set].sort((a, b) => a - b), wildcard };
}

/** Split a pattern into fields and pick the 5- or 6-field layout. */
function splitFields(pattern: string): { specs: FieldSpec[]; tokens: string[]; hasSeconds: boolean } {
  const tokens = pattern.trim().split(/\s+/);
  if (tokens.length === 6) {
    return { specs: [SECOND_SPEC, ...FIELD_SPECS_5], tokens, hasSeconds: true };
  }
  if (tokens.length === 5) {
    return { specs: FIELD_SPECS_5, tokens, hasSeconds: false };
  }
  throw new CronError(
    `expected 5 or 6 fields, got ${tokens.length} (pattern: "${pattern.trim()}")`,
  );
}

/**
 * Validate a cron pattern. Never throws — failures are reported in `errors`.
 * Adds `warnings` for technically-valid but suspicious patterns (e.g. an
 * every-minute schedule, or a day/month combination that can never occur).
 */
export function validateCron(pattern: string): CronValidationResult {
  const result: CronValidationResult = {
    valid: false,
    pattern,
    fieldCount: 0,
    hasSeconds: false,
    errors: [],
    warnings: [],
  };

  if (typeof pattern !== "string" || pattern.trim() === "") {
    result.errors.push("pattern is empty");
    return result;
  }

  let specs: FieldSpec[];
  let tokens: string[];
  try {
    const split = splitFields(pattern);
    specs = split.specs;
    tokens = split.tokens;
    result.hasSeconds = split.hasSeconds;
    result.fieldCount = tokens.length;
  } catch (err) {
    result.errors.push((err as Error).message);
    return result;
  }

  const fields: CronField[] = [];
  for (let i = 0; i < specs.length; i++) {
    try {
      fields.push(parseField(tokens[i] as string, specs[i] as FieldSpec));
    } catch (err) {
      result.errors.push((err as Error).message);
    }
  }
  if (result.errors.length > 0) return result;

  result.valid = true;
  result.fields = fields;
  result.warnings = collectWarnings(fields, result.hasSeconds);
  return result;
}

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function collectWarnings(fields: CronField[], hasSeconds: boolean): string[] {
  const warnings: string[] = [];
  const byName = Object.fromEntries(fields.map((f) => [f.name, f]));

  const second = byName.second;
  const minute = byName.minute;
  if (hasSeconds && second && second.wildcard) {
    warnings.push("runs every second — this is almost never intended");
  } else if (minute && minute.wildcard && (!hasSeconds || (second && second.values.length === 1))) {
    warnings.push("runs every minute — high frequency, double-check this is intended");
  }

  // Day-of-month that can never occur in the selected month(s).
  const dom = byName["day-of-month"];
  const month = byName.month;
  if (dom && month && !dom.wildcard && !month.wildcard) {
    const everReachable = month.values.some((m) =>
      dom.values.some((d) => d <= (DAYS_IN_MONTH[m - 1] as number)),
    );
    if (!everReachable) {
      warnings.push(
        "the day-of-month never occurs in the selected month(s) — this schedule will never fire",
      );
    }
  }

  return warnings;
}

function matches(date: Date, fields: CronField[], hasSeconds: boolean): boolean {
  const get = (name: string) => fields.find((f) => f.name === name);
  if (hasSeconds) {
    const s = get("second");
    if (s && !s.values.includes(date.getUTCSeconds())) return false;
  }
  const minute = get("minute");
  const hour = get("hour");
  const month = get("month");
  if (minute && !minute.values.includes(date.getUTCMinutes())) return false;
  if (hour && !hour.values.includes(date.getUTCHours())) return false;
  if (month && !month.values.includes(date.getUTCMonth() + 1)) return false;

  // Vixie-cron day rule: when BOTH dom and dow are restricted, either matching
  // counts; otherwise the restricted one (or both wildcards) applies.
  const dom = get("day-of-month");
  const dow = get("day-of-week");
  const domRestricted = dom && !dom.wildcard;
  const dowRestricted = dow && !dow.wildcard;
  const domOk = !dom || dom.values.includes(date.getUTCDate());
  const dowOk = !dow || dow.values.includes(date.getUTCDay());

  if (domRestricted && dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

/**
 * Compute the next `count` run times (UTC) at or after `from` (exclusive of
 * `from` itself). Returns fewer than `count` only if the bounded search window
 * (5 years) is exhausted — e.g. for impossible schedules.
 *
 * @throws if the pattern is invalid (call {@link validateCron} first to inspect).
 */
export function getNextRuns(
  pattern: string,
  options: { count?: number; from?: Date } = {},
): Date[] {
  const validation = validateCron(pattern);
  if (!validation.valid || !validation.fields) {
    throw new Error(`bullmq-devkit: invalid cron "${pattern}": ${validation.errors.join("; ")}`);
  }
  const count = options.count ?? 5;
  const fields = validation.fields;
  const hasSeconds = validation.hasSeconds;

  const start = options.from ? new Date(options.from.getTime()) : new Date();
  const cursor = new Date(start.getTime());
  // Advance to the next whole step boundary so `from` itself is never returned.
  if (hasSeconds) {
    cursor.setUTCMilliseconds(0);
    cursor.setUTCSeconds(cursor.getUTCSeconds() + 1);
  } else {
    cursor.setUTCMilliseconds(0);
    cursor.setUTCSeconds(0);
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }

  const stepSeconds = hasSeconds ? 1 : 60;
  const limit = cursor.getTime() + 5 * 365 * 24 * 60 * 60 * 1000;
  const runs: Date[] = [];

  while (runs.length < count && cursor.getTime() <= limit) {
    if (matches(cursor, fields, hasSeconds)) {
      runs.push(new Date(cursor.getTime()));
    }
    cursor.setTime(cursor.getTime() + stepSeconds * 1000);
  }

  return runs;
}
