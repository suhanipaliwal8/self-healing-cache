import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Cluster } from '../src/cluster.js';
import { createServer } from '../src/server.js';
import { CacheClient } from '../src/client.js';
import {
  percentile,
  runLoad,
  verifyKeys,
  summarize,
  formatSummary,
  parseChaosArgs,
} from '../src/chaos.js';

// A client that keeps everything in a Map, like a perfect cache.
function memoryClient() {
  const data = new Map();
  return {
    data,
    async set(key, value) {
      data.set(key, value);
      return true;
    },
    async get(key) {
      return data.has(key) ? { value: data.get(key), expiresAt: null } : undefined;
    },
  };
}

const quickLoad = { durationMs: 80, concurrency: 2, pauseMs: 5 };

test('chaos: percentile picks the right value from a sorted list', () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile(hundred, 50), 50);
  assert.equal(percentile(hundred, 95), 95);
  assert.equal(percentile(hundred, 99), 99);
  assert.equal(percentile(hundred, 100), 100);
  assert.equal(percentile([7], 99), 7);
});

test('chaos: runLoad writes then reads every key and stops after the duration', async () => {
  const client = memoryClient();
  const begin = Date.now();
  const load = await runLoad({ client, ...quickLoad });

  assert.ok(Date.now() - begin < 2000);
  assert.ok(load.writes > 0);
  assert.equal(load.reads, load.writes); // every write was read back
  assert.equal(load.failures.length, 0);
  assert.equal(load.wrong.length, 0);
  assert.equal(load.written.size, load.writes);
  assert.equal(load.latencies.length, load.writes + load.reads);
});

test('chaos: runLoad counts a request that still fails as a failure and tells onFailure', async () => {
  const client = memoryClient();
  client.set = async () => {
    throw new Error('node unreachable');
  };
  const seen = [];
  const load = await runLoad({ client, ...quickLoad, onFailure: (failure) => seen.push(failure) });

  assert.ok(load.failures.length > 0);
  assert.equal(seen.length, load.failures.length);
  assert.equal(load.failures[0].op, 'write');
  assert.equal(load.failures[0].message, 'node unreachable');
  assert.equal(load.reads, 0); // nothing was stored, so nothing was read back
  assert.equal(load.written.size, 0);
});

test('chaos: runLoad notices a read that returns the wrong value', async () => {
  const client = memoryClient();
  client.get = async () => ({ value: 'something else', expiresAt: null });
  const load = await runLoad({ client, ...quickLoad });

  assert.ok(load.wrong.length > 0);
  assert.equal(load.wrong[0].got, 'something else');
  assert.match(load.wrong[0].expected, /^value-/);
});

test('chaos: verifyKeys finds lost keys, wrong values and read errors', async () => {
  const client = {
    async get(key) {
      if (key === 'a') return { value: '1' };
      if (key === 'b') return undefined; // gone
      if (key === 'c') return { value: 'WRONG' };
      throw new Error('boom');
    },
  };
  const written = new Map([['a', '1'], ['b', '2'], ['c', '3'], ['d', '4']]);
  const result = await verifyKeys({ client, written });

  assert.equal(result.checked, 4);
  assert.deepEqual(result.lost, ['b']);
  assert.deepEqual(result.wrong, [{ key: 'c', expected: '3', got: 'WRONG' }]);
  assert.deepEqual(result.errors, [{ key: 'd', message: 'boom' }]);
});

test('chaos: the verdict is PASS only with zero failed requests, zero wrong values and zero lost keys', () => {
  const clean = {
    load: { writes: 10, reads: 10, failures: [], wrong: [], latencies: [5, 1, 3, 2, 4] },
    verify: { checked: 10, lost: [], wrong: [], errors: [] },
    stats: { requests: 20, retries: 3, failures: 0 },
    durationMs: 30_000,
    killedAtMs: 10_000,
  };
  const summary = summarize(clean);
  assert.equal(summary.passed, true);
  assert.equal(summary.requests, 20);
  assert.equal(summary.retries, 3);
  assert.equal(summary.p50, 3);
  assert.equal(summary.max, 5);

  const failure = { op: 'write', key: 'k', message: 'x', atMs: 1 };
  assert.equal(summarize({ ...clean, load: { ...clean.load, failures: [failure] } }).passed, false);
  assert.equal(summarize({ ...clean, load: { ...clean.load, wrong: [{ key: 'k' }] } }).passed, false);
  assert.equal(summarize({ ...clean, verify: { ...clean.verify, lost: ['k'] } }).passed, false);
  assert.equal(summarize({ ...clean, verify: { ...clean.verify, errors: [{ key: 'k' }] } }).passed, false);
});

test('chaos: the report says PASS or FAIL and shows the numbers', () => {
  const base = {
    durationMs: 30_000,
    killedAtMs: 10_000,
    writes: 5,
    reads: 5,
    requests: 10,
    retries: 2,
    failed: 0,
    wrong: 0,
    lost: 0,
    checked: 5,
    p50: 3,
    p95: 9,
    p99: 20,
    max: 25,
  };
  const pass = formatSummary({ ...base, passed: true });
  assert.match(pass, /verdict: PASS/);
  assert.match(pass, /node killed at:\s+10\.0 s/);
  assert.match(pass, /failed requests:\s+0/);
  assert.match(pass, /p99 20/);

  const fail = formatSummary({ ...base, passed: false, failed: 4, killedAtMs: null });
  assert.match(fail, /verdict: FAIL/);
  assert.match(fail, /no kill command was run/);
  assert.match(fail, /failed requests:\s+4/);
});

test('chaos: command line defaults and custom values (times in seconds)', () => {
  assert.deepEqual(parseChaosArgs([], {}), {
    durationMs: 30_000,
    killAtMs: 10_000,
    killCommand: undefined,
    settleMs: 5_000,
    concurrency: 4,
    retries: 1,
    nodes: ['http://localhost:3001', 'http://localhost:3002', 'http://localhost:3003'],
  });

  const custom = parseChaosArgs(
    ['--duration', '20', '--kill-at', '5', '--kill', 'docker compose stop node-c', '--settle', '2',
      '--concurrency', '8', '--retries', '0', '--nodes', 'http://a:1, http://b:2'],
    {},
  );
  assert.equal(custom.durationMs, 20_000);
  assert.equal(custom.killAtMs, 5_000);
  assert.equal(custom.killCommand, 'docker compose stop node-c');
  assert.equal(custom.settleMs, 2_000);
  assert.equal(custom.concurrency, 8);
  assert.equal(custom.retries, 0);
  assert.deepEqual(custom.nodes, ['http://a:1', 'http://b:2']);

  // the NODES environment variable is used when --nodes is not given
  assert.deepEqual(parseChaosArgs([], { NODES: 'http://x:9' }).nodes, ['http://x:9']);
});

test('chaos: bad command lines are refused with a clear message', () => {
  assert.throws(() => parseChaosArgs(['--kill-at', '30'], {}), /--kill-at must be earlier than --duration/);
  assert.throws(() => parseChaosArgs(['--duration', 'abc'], {}), /--duration/);
  assert.throws(() => parseChaosArgs(['--retries', '1.5'], {}), /--retries/);
  assert.throws(() => parseChaosArgs(['--concurrency', '0'], {}), /--concurrency/);
  assert.throws(() => parseChaosArgs(['--bogus', '1'], {}));
});

test('client: with many requests at once, a retry never goes back to the node that just failed', async () => {
  const fetchFn = async (url) => {
    await new Promise((resolve) => setImmediate(resolve)); // let every request start first
    if (new URL(url).host === 'a:1') throw new Error('connection refused');
    return new Response(JSON.stringify({ key: 'k', value: 'v' }), { status: 200 });
  };
  const client = new CacheClient({ nodes: ['http://a:1', 'http://b:2', 'http://c:3'], retries: 1, fetchFn });

  const results = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => client.get(`k${i}`)));
  assert.equal(results.filter((r) => r.status === 'rejected').length, 0);
  assert.equal(client.stats.failures, 0);
  assert.ok(client.stats.retries > 0);
});

test('chaos: killing a node of a real cluster under load gives zero failures, wrong values and lost keys', async (t) => {
  const ids = ['node-a', 'node-b', 'node-c'];
  const servers = new Map();
  for (const id of ids) {
    const cluster = new Cluster({ selfId: id });
    const server = createServer(new Store(), { cluster, forwardTimeoutMs: 500, replicationFactor: 2 });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.set(id, { server, cluster });
  }
  const urls = ids.map((id) => `http://127.0.0.1:${servers.get(id).server.address().port}`);
  for (const { cluster } of servers.values()) ids.forEach((id, i) => cluster.addNode(id, urls[i]));

  const closed = new Set();
  const close = async (id) => {
    if (closed.has(id)) return;
    closed.add(id);
    servers.get(id).server.closeAllConnections();
    await new Promise((resolve) => servers.get(id).server.close(resolve));
  };
  t.after(() => Promise.all(ids.map(close)));

  const client = new CacheClient({ nodes: urls, retries: 1, timeoutMs: 3000 });
  setTimeout(() => void close('node-c'), 300); // the "chaos": a node dies during the run

  const load = await runLoad({ client, durationMs: 1200, concurrency: 4, pauseMs: 10 });
  const verify = await verifyKeys({ client, written: load.written });

  assert.ok(load.written.size > 20, `expected a real load, only ${load.written.size} keys were written`);
  assert.deepEqual(load.failures, []);
  assert.deepEqual(load.wrong, []);
  assert.deepEqual(verify.lost, []);
  assert.deepEqual(verify.wrong, []);
  assert.deepEqual(verify.errors, []);
  assert.ok(client.stats.retries > 0, 'some requests should have hit the dead node and retried');
});