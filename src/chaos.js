import { parseArgs } from 'node:util';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The p-th percentile (0 to 100) of a list that is already sorted from small
// to large. p99 = "99 out of 100 requests were at least this fast".
export function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, index))];
}

// The load generator. `concurrency` workers each loop until the time is up:
//   write a new key, then read it straight back and check the value.
// A request that still fails after the client's retries is a FAILURE.
// A read that returns a different value is a WRONG value.
// Everything that was written successfully is remembered in `written`, so we
// can check later that no key was LOST.
export async function runLoad({
  client,
  durationMs,
  concurrency = 4,
  pauseMs = 20,
  keyPrefix = 'chaos',
  onFailure,
  clock = Date.now,
  sleep = defaultSleep,
}) {
  const startedAt = clock();
  const endAt = startedAt + durationMs;
  const load = { writes: 0, reads: 0, failures: [], wrong: [], latencies: [], written: new Map() };

  // Run one request, time it, and record a failure instead of throwing.
  async function attempt(op, key, action) {
    const begin = clock();
    try {
      await action();
      load.latencies.push(clock() - begin);
      return true;
    } catch (error) {
      const failure = { op, key, message: error.message, atMs: clock() - startedAt };
      load.failures.push(failure);
      onFailure?.(failure);
      return false;
    }
  }

  async function worker(id) {
    for (let n = 0; clock() < endAt; n++) {
      const key = `${keyPrefix}-${id}-${n}`;
      const value = `value-${id}-${n}`;

      load.writes++;
      const stored = await attempt('write', key, () => client.set(key, value, { ttl: 600 }));
      if (stored) {
        load.written.set(key, value);
        load.reads++;
        await attempt('read', key, async () => {
          const got = await client.get(key);
          if (got?.value !== value) load.wrong.push({ key, expected: value, got: got?.value });
        });
      }
      await sleep(pauseMs);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, (_, id) => worker(id)));
  return load;
}

// After the chaos: read back EVERY key that was written. A key that is gone
// is LOST, a key with another value is WRONG, a read that errors is an ERROR.
export async function verifyKeys({ client, written, concurrency = 8 }) {
  const result = { checked: 0, lost: [], wrong: [], errors: [] };
  const queue = [...written];

  async function worker() {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      const [key, value] = item;
      result.checked++;
      try {
        const got = await client.get(key);
        if (got === undefined) result.lost.push(key);
        else if (got.value !== value) result.wrong.push({ key, expected: value, got: got.value });
      } catch (error) {
        result.errors.push({ key, message: error.message });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return result;
}

// Turn the raw results into numbers and a verdict. PASS means: zero failed
// requests, zero wrong values and zero lost keys.
export function summarize({ load, verify, stats, durationMs, killedAtMs = null }) {
  const sorted = [...load.latencies].sort((a, b) => a - b);
  const failed = load.failures.length + verify.errors.length;
  const wrong = load.wrong.length + verify.wrong.length;
  const lost = verify.lost.length;
  return {
    passed: failed === 0 && wrong === 0 && lost === 0,
    durationMs,
    killedAtMs,
    writes: load.writes,
    reads: load.reads,
    requests: load.writes + load.reads,
    retries: stats.retries,
    failed,
    wrong,
    lost,
    checked: verify.checked,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: percentile(sorted, 100),
  };
}

export function formatSummary(summary) {
  const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
  const lines = [
    'Chaos demo result',
    `  duration:            ${seconds(summary.durationMs)}`,
    `  node killed at:      ${summary.killedAtMs === null ? 'no kill command was run' : seconds(summary.killedAtMs)}`,
    `  requests:            ${summary.requests} (${summary.writes} writes, ${summary.reads} reads)`,
    `  retries used:        ${summary.retries}`,
    `  failed requests:     ${summary.failed}`,
    `  wrong values:        ${summary.wrong}`,
    `  keys checked after:  ${summary.checked}, lost: ${summary.lost}`,
    `  latency (ms):        p50 ${summary.p50}, p95 ${summary.p95}, p99 ${summary.p99}, max ${summary.max}`,
    summary.passed
      ? '  verdict: PASS (zero failed requests, zero wrong values, zero lost keys)'
      : '  verdict: FAIL',
  ];
  return lines.join('\n');
}

const DEFAULT_NODES = 'http://localhost:3001,http://localhost:3002,http://localhost:3003';

function number(name, text, fallback, { min, integer = false }) {
  if (text === undefined) return fallback;
  const value = Number(text);
  if (!Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
    throw new Error(`--${name} must be ${integer ? 'a whole number' : 'a number'} >= ${min}, got "${text}"`);
  }
  return value;
}

// Read the command line of the chaos demo. Times on the command line are in
// seconds; the result is in milliseconds. Throws a clear message on bad input.
export function parseChaosArgs(argv, env = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: {
      duration: { type: 'string' },
      'kill-at': { type: 'string' },
      kill: { type: 'string' },
      settle: { type: 'string' },
      concurrency: { type: 'string' },
      retries: { type: 'string' },
      nodes: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });

  const duration = number('duration', values.duration, 30, { min: 1 });
  const killAt = number('kill-at', values['kill-at'], duration > 10 ? 10 : duration / 3, { min: 0 });
  if (killAt >= duration) throw new Error('--kill-at must be earlier than --duration');

  return {
    durationMs: duration * 1000,
    killAtMs: killAt * 1000,
    killCommand: values.kill,
    settleMs: number('settle', values.settle, 5, { min: 0 }) * 1000,
    concurrency: number('concurrency', values.concurrency, 4, { min: 1, integer: true }),
    retries: number('retries', values.retries, 1, { min: 0, integer: true }),
    nodes: (values.nodes ?? env.NODES ?? DEFAULT_NODES)
      .split(',')
      .map((url) => url.trim())
      .filter(Boolean),
  };
}