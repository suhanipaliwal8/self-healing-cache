import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Store } from '../src/store.js';
import { Cluster } from '../src/cluster.js';
import { createServer } from '../src/server.js';
import { FailureDetector } from '../src/failure-detector.js';

// Starts a fresh 3-node cluster (replication factor 2). Nodes listed in
// `frozen` accept connections but never answer, like a hung machine.
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
    owners: (key) => nodes.get('node-a').cluster.ownersOf(key, 2).map((o) => o.id),
    // first generated key whose [primary, replica] satisfies the test
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

test('routing: reads skip a node marked down and go straight to the replica', async (t) => {
  const c = await startCluster();
  t.after(() => c.stopAll());

  await call(c, 'node-a', 'user:1', { method: 'PUT', body: { value: 'alice' } });
  const [primary, replica] = c.owners('user:1');
  const coordinator = c.ids.find((id) => id !== primary && id !== replica);

  c.cluster(coordinator).markDown(primary); // the primary is actually fine
  assert.equal((await call(c, coordinator, 'user:1')).headers.get('x-served-by'), replica);

  c.cluster(coordinator).markUp(primary);
  assert.equal((await call(c, coordinator, 'user:1')).headers.get('x-served-by'), primary);
});

test('routing: a wrongly suspected node is still the last resort, so no outage', async (t) => {
  const c = await startCluster();
  t.after(() => c.stopAll());

  await call(c, 'node-a', 'user:1', { method: 'PUT', body: { value: 'alice' } });
  const owners = c.owners('user:1');
  const coordinator = c.ids.find((id) => !owners.includes(id));

  for (const id of owners) c.cluster(coordinator).markDown(id); // wrong: both are fine
  const res = await call(c, coordinator, 'user:1');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { key: 'user:1', value: 'alice' });
});

test('routing: a read no longer waits for a frozen primary once it is marked down', async (t) => {
  const c = await startCluster({ frozen: ['node-c'] });
  t.after(() => c.stopAll());

  const key = c.findKey(([primary]) => primary === 'node-c');
  const [, replica] = c.owners(key);
  c.nodes.get(replica).store.set(key, 'v'); // the replica holds a copy
  const coordinator = c.ids.find((id) => id !== 'node-c' && id !== replica);

  const slow = await timed(() => call(c, coordinator, key)); // detector has not noticed yet
  assert.equal(slow.res.status, 200);
  assert.ok(slow.ms >= 500, `expected to wait for the timeout, took ${slow.ms}ms`);

  c.cluster(coordinator).markDown('node-c');
  const fast = await timed(() => call(c, coordinator, key));
  assert.equal(fast.res.status, 200);
  assert.equal(fast.res.headers.get('x-served-by'), replica);
  assert.ok(fast.ms < 200, `expected an instant answer, took ${fast.ms}ms`);
});

test('routing: sync replication does not wait for a replica marked down', async (t) => {
  const c = await startCluster({ frozen: ['node-c'] });
  t.after(() => c.stopAll());

  const key = c.findKey(([, replica]) => replica === 'node-c');
  const [primary] = c.owners(key);
  c.cluster(primary).markDown('node-c');

  const { res, ms } = await timed(() => call(c, primary, key, { method: 'PUT', body: { value: 'x' } }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-replicated-to'), null);
  assert.equal(c.nodes.get(primary).store.get(key), 'x');
  assert.ok(ms < 200, `expected no waiting, took ${ms}ms`);
});

test('routing: GET /cluster shows each node as up or down', async (t) => {
  const c = await startCluster();
  t.after(() => c.stopAll());

  c.cluster('node-a').markDown('node-b');
  const body = await (await fetch(`${c.nodes.get('node-a').url}/cluster`)).json();
  const status = Object.fromEntries(body.nodes.map((n) => [n.id, n.status]));
  assert.deepEqual(status, { 'node-a': 'up', 'node-b': 'down', 'node-c': 'up' });
});

test('routing: a detector notices a stopped node and reads move to the replica', async (t) => {
  const c = await startCluster();
  t.after(() => c.stopAll());

  const key = c.findKey(([primary]) => primary === 'node-c');
  const [, replica] = c.owners(key);
  await call(c, 'node-a', key, { method: 'PUT', body: { value: 'alice' } });

  await c.stop('node-c');
  const detector = new FailureDetector({ cluster: c.cluster('node-a'), failureThreshold: 3, timeoutMs: 200 });
  await detector.checkOnce();
  await detector.checkOnce();
  assert.equal(c.cluster('node-a').isUp('node-c'), true); // 2 of 3
  await detector.checkOnce();
  assert.equal(c.cluster('node-a').isUp('node-c'), false);

  const res = await call(c, 'node-a', key);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-served-by'), replica);
});