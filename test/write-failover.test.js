import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Store } from '../src/store.js';
import { Cluster } from '../src/cluster.js';
import { createServer } from '../src/server.js';

// Starts a fresh 3-node cluster. Nodes listed in `frozen` accept connections
// but never answer, like a hung machine.
async function startCluster({ frozen = [], ...options } = {}) {
  const ids = ['node-a', 'node-b', 'node-c'];
  const nodes = new Map();
  for (const id of ids) {
    const store = new Store();
    const cluster = new Cluster({ selfId: id });
    const server = frozen.includes(id)
      ? http.createServer(() => {})
      : createServer(store, { cluster, forwardTimeoutMs: 600, replicationFactor: 2, ...options });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    nodes.set(id, { store, cluster, server, running: true, url: `http://127.0.0.1:${server.address().port}` });
  }
  for (const { cluster } of nodes.values()) {
    for (const [id, { url }] of nodes) cluster.addNode(id, url);
  }

  return {
    ids,
    nodes,
    cluster: (id) => nodes.get(id).cluster,
    owners: (key, count = 2) => nodes.get('node-a').cluster.ownersOf(key, count).map((o) => o.id),
    findKey(predicate) {
      for (let i = 0; ; i++) {
        if (predicate(this.owners(`k${i}`))) return `k${i}`;
      }
    },
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

async function timed(action) {
  const start = Date.now();
  const res = await action();
  return { res, ms: Date.now() - start };
}

test('failover: a write goes to the replica when the primary is down', async (t) => {
  const c = await startCluster();
  t.after(() => c.stopAll());

  const key = 'user:1';
  const [primary, replica] = c.owners(key);
  const coordinator = c.ids.find((id) => id !== primary && id !== replica);
  await c.stop(primary);

  const res = await call(c, coordinator, key, { method: 'PUT', body: { value: 'alice', ttl: 60 } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-served-by'), replica);
  assert.equal(res.headers.get('x-failed-over-from'), primary);

  const entry = c.nodes.get(replica).store.getEntry(key);
  assert.equal(entry.value, 'alice');
  assert.ok(entry.expiresAt > Date.now()); // the ttl survived the failover

  for (const id of c.ids.filter((n) => n !== primary)) {
    const read = await call(c, id, key);
    assert.deepEqual(await read.json(), { key, value: 'alice', expiresAt: entry.expiresAt });
  }
});

test('failover: the replica takes over when the client talks to it directly', async (t) => {
  const c = await startCluster();
  t.after(() => c.stopAll());

  const key = 'user:1';
  const [primary, replica] = c.owners(key);
  await c.stop(primary);

  const res = await call(c, replica, key, { method: 'PUT', body: { value: 'bob' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-served-by'), replica);
  assert.equal(res.headers.get('x-failed-over-from'), primary);
  assert.equal(c.nodes.get(replica).store.get(key), 'bob');
});

test('failover: DELETE also fails over', async (t) => {
  const c = await startCluster();
  t.after(() => c.stopAll());

  const key = 'user:1';
  const [primary, replica] = c.owners(key);
  const coordinator = c.ids.find((id) => id !== primary && id !== replica);
  await call(c, coordinator, key, { method: 'PUT', body: { value: 'alice' } });
  await c.stop(primary);

  const res = await call(c, coordinator, key, { method: 'DELETE' });
  assert.deepEqual(await res.json(), { deleted: true });
  assert.equal(res.headers.get('x-failed-over-from'), primary);
  assert.equal(c.nodes.get(replica).store.has(key), false);
});

test('failover: a primary that is only suspected is skipped, then catches up', async (t) => {
  const c = await startCluster();
  t.after(() => c.stopAll());

  const key = 'user:1';
  const [primary, replica] = c.owners(key);
  const coordinator = c.ids.find((id) => id !== primary && id !== replica);
  c.cluster(coordinator).markDown(primary); // wrong guess: the primary is fine

  const res = await call(c, coordinator, key, { method: 'PUT', body: { value: 'carol' } });
  assert.equal(res.headers.get('x-served-by'), replica);
  assert.equal(res.headers.get('x-failed-over-from'), primary);
  // the acting primary copied the write to the real primary
  assert.equal(res.headers.get('x-replicated-to'), primary);
  assert.equal(c.nodes.get(primary).store.get(key), 'carol');
});

test('failover: 502 when every node holding the key is down', async (t) => {
  const c = await startCluster();
  t.after(() => c.stopAll());

  const key = 'user:1';
  const owners = c.owners(key);
  const coordinator = c.ids.find((id) => !owners.includes(id));
  for (const id of owners) await c.stop(id);

  const res = await call(c, coordinator, key, { method: 'PUT', body: { value: 'x' } });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /every node holding this key is unreachable/);
});

test('failover: with a single copy (replication factor 1) there is nothing to fail over to', async (t) => {
  const c = await startCluster({ replicationFactor: 1 });
  t.after(() => c.stopAll());

  const key = 'user:1';
  const [owner] = c.owners(key, 1);
  const coordinator = c.ids.find((id) => id !== owner);
  await c.stop(owner);

  const res = await call(c, coordinator, key, { method: 'PUT', body: { value: 'x' } });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, new RegExp(`${owner} is unreachable`));
});

test('failover: a frozen primary costs one timeout, then writes are instant', async (t) => {
  const c = await startCluster({ frozen: ['node-c'] });
  t.after(() => c.stopAll());

  const key = c.findKey(([primary]) => primary === 'node-c');
  const [, replica] = c.owners(key);
  const coordinator = c.ids.find((id) => id !== 'node-c' && id !== replica);

  const slow = await timed(() => call(c, coordinator, key, { method: 'PUT', body: { value: 'one' } }));
  assert.equal(slow.res.status, 200);
  assert.equal(slow.res.headers.get('x-served-by'), replica);
  assert.ok(slow.ms >= 500, `expected to wait for the timeout, took ${slow.ms}ms`);

  for (const id of ['node-a', 'node-b']) c.cluster(id).markDown('node-c'); // heartbeats noticed
  const fast = await timed(() => call(c, coordinator, key, { method: 'PUT', body: { value: 'two' } }));
  assert.equal(fast.res.status, 200);
  assert.equal(c.nodes.get(replica).store.get(key), 'two');
  assert.ok(fast.ms < 200, `expected an instant write, took ${fast.ms}ms`);
});