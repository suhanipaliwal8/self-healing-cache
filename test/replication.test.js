import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Cluster } from '../src/cluster.js';
import { createServer } from '../src/server.js';

// Starts a fresh 3-node cluster on free ports. Every test gets its own
// cluster, so tests that stop nodes cannot disturb each other.
async function startCluster({ now, ...options } = {}) {
  const ids = ['node-a', 'node-b', 'node-c'];
  const nodes = new Map();
  for (const id of ids) {
    const store = new Store({ now });
    const cluster = new Cluster({ selfId: id });
    const server = createServer(store, {
      cluster,
      forwardTimeoutMs: 500,
      replicationFactor: 2,
      ...options,
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    nodes.set(id, { store, cluster, server, running: true, url: `http://127.0.0.1:${server.address().port}` });
  }
  for (const { cluster } of nodes.values()) {
    for (const [id, { url }] of nodes) cluster.addNode(id, url);
  }

  return {
    ids,
    nodes,
    // [primary, replica, ...] for a key, as every node agrees
    owners: (key, count = 2) => nodes.get('node-a').cluster.ownersOf(key, count).map((o) => o.id),
    holders: (key) => ids.filter((id) => nodes.get(id).store.has(key)).sort(),
    async stop(id) {
      const node = nodes.get(id);
      node.server.closeAllConnections();
      await new Promise((resolve) => node.server.close(resolve));
      node.running = false;
    },
    async stopAll() {
      for (const id of ids) if (nodes.get(id).running) await this.stop(id);
    },
  };
}

function call(c, id, key, { method = 'GET', body } = {}) {
  return fetch(`${c.nodes.get(id).url}/keys/${key}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function waitFor(condition, timeoutMs = 1000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('replication: a write lives on the primary and one replica, not on the third node', async (t) => {
  const c = await startCluster();
  t.after(() => c.stopAll());

  const res = await call(c, 'node-a', 'user:1', { method: 'PUT', body: { value: 'alice' } });
  assert.equal(res.status, 200);

  assert.equal(c.holders('user:1').length, 2);
  assert.deepEqual(c.holders('user:1'), c.owners('user:1').sort());
});

test('replication: the response says which replica confirmed the copy', async (t) => {
  const c = await startCluster();
  t.after(() => c.stopAll());

  const res = await call(c, 'node-b', 'user:2', { method: 'PUT', body: { value: 'bob' } });
  const [, replica] = c.owners('user:2');
  assert.equal(res.headers.get('x-replicated-to'), replica);
});

test('replication: primary and replica store the SAME absolute expiresAt', async (t) => {
  const c = await startCluster();
  t.after(() => c.stopAll());

  await call(c, 'node-c', 'session', { method: 'PUT', body: { value: 'abc', ttl: 60 } });
  const [primary, replica] = c.owners('session');
  const a = c.nodes.get(primary).store.getEntry('session');
  const b = c.nodes.get(replica).store.getEntry('session');

  assert.ok(a.expiresAt > Date.now());
  assert.equal(a.expiresAt, b.expiresAt);
});

test('replication: a key expires at the same moment on every copy', async (t) => {
  let time = 1_000_000;
  const c = await startCluster({ now: () => time });
  t.after(() => c.stopAll());

  await call(c, 'node-a', 'short-lived', { method: 'PUT', body: { value: 1, ttl: 10 } });
  assert.equal(c.holders('short-lived').length, 2);

  time = 1_009_999; // one millisecond before expiry
  assert.equal(c.holders('short-lived').length, 2);

  time = 1_010_000; // exactly at expiry
  assert.equal(c.holders('short-lived').length, 0);
});

test('replication: DELETE removes the key from the primary and the replica', async (t) => {
  const c = await startCluster();
  t.after(() => c.stopAll());

  await call(c, 'node-a', 'temp', { method: 'PUT', body: { value: 1 } });
  assert.equal(c.holders('temp').length, 2);

  const del = await call(c, 'node-c', 'temp', { method: 'DELETE' });
  assert.deepEqual(await del.json(), { deleted: true });
  assert.equal(c.holders('temp').length, 0);
});

test('replication: reads still succeed from the replica when the primary is down', async (t) => {
  const c = await startCluster();
  t.after(() => c.stopAll());

  await call(c, 'node-a', 'user:1', { method: 'PUT', body: { value: 'alice' } });
  const [primary, replica] = c.owners('user:1');
  await c.stop(primary);

  for (const id of c.ids.filter((n) => n !== primary)) {
    const res = await call(c, id, 'user:1');
    assert.equal(res.status, 200, `asking ${id}`);
    assert.deepEqual(await res.json(), { key: 'user:1', value: 'alice' });
    assert.equal(res.headers.get('x-served-by'), replica);
  }
});

test('replication: a write still succeeds when the replica is down', async (t) => {
  const c = await startCluster();
  t.after(() => c.stopAll());

  const [primary, replica] = c.owners('user:3');
  const third = c.ids.find((id) => id !== primary && id !== replica);
  await c.stop(replica);

  const res = await call(c, third, 'user:3', { method: 'PUT', body: { value: 'carol' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-replicated-to'), null); // nobody confirmed
  assert.equal(c.nodes.get(primary).store.get('user:3'), 'carol');
});

test('replication: 502 only when every node holding the key is down', async (t) => {
  const c = await startCluster();
  t.after(() => c.stopAll());

  await call(c, 'node-a', 'user:1', { method: 'PUT', body: { value: 'alice' } });
  const owners = c.owners('user:1');
  const third = c.ids.find((id) => !owners.includes(id));
  for (const id of owners) await c.stop(id);

  const res = await call(c, third, 'user:1');
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /every node holding this key is unreachable/);
});

test('replication: async mode answers first and copies in the background', async (t) => {
  const c = await startCluster({ replicationMode: 'async' });
  t.after(() => c.stopAll());

  const res = await call(c, 'node-a', 'user:1', { method: 'PUT', body: { value: 'alice' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-replicated-to'), null); // we did not wait

  const [, replica] = c.owners('user:1');
  await waitFor(() => c.nodes.get(replica).store.has('user:1'));
  assert.equal(c.holders('user:1').length, 2);
});

test('replication: the internal endpoint validates input and stores exactly one copy', async (t) => {
  const c = await startCluster();
  t.after(() => c.stopAll());

  const url = `${c.nodes.get('node-a').url}/internal/keys/k`;
  const send = (body) =>
    fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  assert.equal((await send({ value: 1 })).status, 400); // expiresAt is required
  assert.equal((await send({ value: 1, expiresAt: 'soon' })).status, 400);

  assert.equal((await send({ value: 'copy', expiresAt: null })).status, 200);
  assert.deepEqual(c.holders('k'), ['node-a']); // stored here, not copied onwards
});

test('replication: a factor larger than the cluster just means "every node"', async (t) => {
  const c = await startCluster({ replicationFactor: 5 });
  t.after(() => c.stopAll());

  await call(c, 'node-a', 'everywhere', { method: 'PUT', body: { value: 1 } });
  assert.deepEqual(c.holders('everywhere'), ['node-a', 'node-b', 'node-c']);
});