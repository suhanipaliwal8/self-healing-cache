import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Store } from '../src/store.js';
import { Cluster } from '../src/cluster.js';
import { createServer } from '../src/server.js';
import { CacheClient, CacheError } from '../src/client.js';

// A fake fetch. It answers from a list (the last answer repeats) and records
// every call. An answer that is an Error is thrown, like a network failure.
function fakeFetch(...answers) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url: String(url), method: options.method, body: options.body });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status });
  };
  fn.calls = calls;
  return fn;
}
const ok = (body = {}) => ({ status: 200, body });
const refused = () => new Error('connection refused');

test('client: needs at least one node', () => {
  assert.throws(() => new CacheClient({ nodes: [] }), /at least one node/);
});

test('client: spreads requests over the nodes in turn and tidies trailing slashes', async () => {
  const fetchFn = fakeFetch(ok());
  const client = new CacheClient({ nodes: ['http://a:1', 'http://b:2', 'http://c:3/'], fetchFn });
  for (let i = 0; i < 6; i++) await client.set('k', i);

  const hosts = fetchFn.calls.map((call) => new URL(call.url).host);
  assert.deepEqual(hosts, ['a:1', 'b:2', 'c:3', 'a:1', 'b:2', 'c:3']);
  assert.equal(fetchFn.calls[2].url, 'http://c:3/keys/k');
});

test('client: get, set and delete read the answers correctly', async () => {
  const get = new CacheClient({
    nodes: ['http://a:1'],
    fetchFn: fakeFetch(ok({ key: 'k', value: 'v', expiresAt: 99 }), { status: 404 }),
  });
  assert.deepEqual(await get.get('k'), { value: 'v', expiresAt: 99 });
  assert.equal(await get.get('k'), undefined); // 404 means "no such key"

  const setFetch = fakeFetch(ok());
  const set = new CacheClient({ nodes: ['http://a:1'], fetchFn: setFetch });
  assert.equal(await set.set('k', { n: 1 }, { ttl: 30 }), true);
  assert.deepEqual(JSON.parse(setFetch.calls[0].body), { value: { n: 1 }, ttl: 30 });
  assert.equal(setFetch.calls[0].method, 'PUT');

  const del = new CacheClient({ nodes: ['http://a:1'], fetchFn: fakeFetch(ok({ deleted: true })) });
  assert.equal(await del.delete('k'), true);
});

test('client: a node that does not answer is retried on the next node', async () => {
  const fetchFn = fakeFetch(refused(), ok());
  const client = new CacheClient({ nodes: ['http://a:1', 'http://b:2'], fetchFn });

  assert.equal(await client.set('k', 1), true);
  assert.equal(fetchFn.calls.length, 2);
  assert.notEqual(new URL(fetchFn.calls[0].url).host, new URL(fetchFn.calls[1].url).host);
  assert.deepEqual(client.stats, { requests: 1, retries: 1, failures: 0 });
});

test('client: 502, 503 and 504 are retried', async () => {
  for (const status of [502, 503, 504]) {
    const fetchFn = fakeFetch({ status }, ok());
    const client = new CacheClient({ nodes: ['http://a:1', 'http://b:2'], fetchFn });
    assert.equal(await client.set('k', 1), true, `status ${status}`);
    assert.equal(fetchFn.calls.length, 2);
  }
});

test('client: real answers are not retried (404 is a value, 400 is our mistake)', async () => {
  const missing = fakeFetch({ status: 404 });
  const client1 = new CacheClient({ nodes: ['http://a:1', 'http://b:2'], fetchFn: missing });
  assert.equal(await client1.get('k'), undefined);
  assert.equal(missing.calls.length, 1);

  const bad = fakeFetch({ status: 400 });
  const client2 = new CacheClient({ nodes: ['http://a:1', 'http://b:2'], fetchFn: bad });
  await assert.rejects(() => client2.set('k', 1), CacheError);
  assert.equal(bad.calls.length, 1);
});

test('client: gives up after retries + 1 attempts with a CacheError', async () => {
  for (const retries of [0, 1, 2]) {
    const fetchFn = fakeFetch(refused());
    const client = new CacheClient({ nodes: ['http://a:1', 'http://b:2'], retries, fetchFn });

    await assert.rejects(
      () => client.get('k'),
      (error) => error instanceof CacheError && error.message.includes(`${retries + 1} attempt`),
    );
    assert.equal(fetchFn.calls.length, retries + 1);
    assert.equal(client.stats.failures, 1);
    assert.equal(client.stats.retries, retries);
  }
});

test('client: a node that hangs is given up on after the timeout and the next node is used', async (t) => {
  const hung = http.createServer(() => {}); // accepts connections, never answers
  const aliveStore = new Store();
  const alive = createServer(aliveStore);
  for (const server of [hung, alive]) {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
  }
  const url = (server) => `http://127.0.0.1:${server.address().port}`;

  const client = new CacheClient({ nodes: [url(hung), url(alive)], timeoutMs: 150 });
  assert.equal(await client.set('k', 'v'), true);
  assert.equal(aliveStore.get('k'), 'v');
  assert.equal(client.stats.retries, 1);
});

test('client + cluster: killing a node mid-traffic causes zero failed requests', async (t) => {
  const ids = ['node-a', 'node-b', 'node-c'];
  const servers = new Map();
  const clusters = new Map();
  for (const id of ids) {
    const cluster = new Cluster({ selfId: id });
    const server = createServer(new Store(), { cluster, forwardTimeoutMs: 500, replicationFactor: 2 });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.set(id, server);
    clusters.set(id, cluster);
  }
  const urls = ids.map((id) => `http://127.0.0.1:${servers.get(id).address().port}`);
  for (const cluster of clusters.values()) ids.forEach((id, i) => cluster.addNode(id, urls[i]));
  const closed = new Set();
  const close = async (id) => {
    if (closed.has(id)) return;
    closed.add(id);
    servers.get(id).closeAllConnections();
    await new Promise((resolve) => servers.get(id).close(resolve));
  };
  t.after(() => Promise.all(ids.map(close)));

  const client = new CacheClient({ nodes: urls, retries: 1, timeoutMs: 2000 });

  for (let i = 0; i < 15; i++) await client.set(`before-${i}`, i); // all nodes alive
  await close('node-c'); // kill one node, no warning
  for (let i = 0; i < 30; i++) {
    await client.set(`after-${i}`, i);
    assert.equal((await client.get(`after-${i}`)).value, i);
  }
  for (let i = 0; i < 15; i++) {
    assert.equal((await client.get(`before-${i}`)).value, i); // old keys survive too
  }

  assert.equal(client.stats.failures, 0);
  assert.ok(client.stats.retries > 0, 'some requests should have hit the dead node and retried');
});