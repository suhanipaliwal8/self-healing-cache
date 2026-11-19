import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Cluster } from '../src/cluster.js';
import { createServer } from '../src/server.js';

// Three nodes, every key on all three (N=3). Quorum W=2 and R=2 unless told otherwise.
async function startNode(id, quorum) {
  const store = new Store();
  const cluster = new Cluster({ selfId: id });
  const server = createServer(store, {
    cluster,
    forwardTimeoutMs: 500,
    replicationFactor: 3,
    ...quorum,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  cluster.addNode(id, url);
  return { id, store, cluster, server, url, running: true };
}

async function startCluster(t, quorum = { writeQuorum: 2, readQuorum: 2 }) {
  const nodes = {};
  for (const id of ['node-a', 'node-b', 'node-c']) nodes[id] = await startNode(id, quorum);
  for (const node of Object.values(nodes)) {
    for (const other of Object.values(nodes)) node.cluster.addNode(other.id, other.url);
  }
  const stop = async (id) => {
    const node = nodes[id];
    if (!node.running) return;
    node.running = false;
    node.server.closeAllConnections();
    await new Promise((resolve) => node.server.close(resolve));
  };
  t.after(async () => {
    for (const id of Object.keys(nodes)) await stop(id);
  });
  return { nodes, stop };
}

const call = (node, path, { method = 'GET', body } = {}) =>
  fetch(`${node.url}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function waitFor(condition, timeoutMs = 4000) {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- writes ----------

test('quorum write: with every node up, the write succeeds and reaches all three copies', async (t) => {
  const { nodes } = await startCluster(t);
  const res = await call(nodes['node-a'], '/keys/k1', { method: 'PUT', body: { value: 'v1' } });
  assert.equal(res.status, 200);
  // two acks were enough to answer; the third copy arrives right after
  await waitFor(() => Object.values(nodes).every((node) => node.store.has('k1')));
});

test('quorum write: one node down is fine (W=2 of N=3)', async (t) => {
  const { nodes, stop } = await startCluster(t);
  await stop('node-c');

  const res = await call(nodes['node-a'], '/keys/k2', { method: 'PUT', body: { value: 'v2' } });
  assert.equal(res.status, 200);
  assert.equal(nodes['node-a'].store.get('k2'), 'v2');
  assert.equal(nodes['node-b'].store.get('k2'), 'v2');
});

test('quorum write: two nodes down means 503, because only 1 of the 2 needed acks exists', async (t) => {
  const { nodes, stop } = await startCluster(t);
  await stop('node-b');
  await stop('node-c');

  const res = await call(nodes['node-a'], '/keys/k3', { method: 'PUT', body: { value: 'v3' } });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.match(body.error, /write quorum not reached/);
  assert.equal(body.needed, 2);
  assert.equal(body.got, 1);
});

test('quorum write: a delete leaves a tombstone, and later reads answer 404', async (t) => {
  const { nodes } = await startCluster(t);
  assert.equal((await call(nodes['node-a'], '/keys/k8', { method: 'PUT', body: { value: 'v8' } })).status, 200);
  await sleep(5); // so the delete gets a clearly newer version than the write
  assert.equal((await call(nodes['node-b'], '/keys/k8', { method: 'DELETE' })).status, 200);

  const res = await call(nodes['node-c'], '/keys/k8');
  assert.equal(res.status, 404);
});

// ---------- reads ----------

test('quorum read: returns the NEWEST copy even when this node holds an old one', async (t) => {
  const { nodes } = await startCluster(t);
  const fresh = { value: 'new', expiresAt: null, version: 200, writer: 'node-a' };
  nodes['node-a'].store.applyRecord('k4', fresh);
  nodes['node-b'].store.applyRecord('k4', fresh);
  nodes['node-c'].store.applyRecord('k4', { value: 'old', expiresAt: null, version: 100, writer: 'node-a' });

  // node-c itself only knows "old", but one more answer is needed and it is "new"
  const res = await call(nodes['node-c'], '/keys/k4');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).value, 'new');
});

test('quorum read: repairs a copy that was missing the key', async (t) => {
  const { nodes } = await startCluster(t);
  nodes['node-b'].store.applyRecord('k5', { value: 'fresh', expiresAt: null, version: 100, writer: 'node-b' });

  const res = await call(nodes['node-b'], '/keys/k5');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).value, 'fresh');

  // the node that answered "I have nothing" gets the key in the background
  await waitFor(() => nodes['node-a'].store.has('k5') || nodes['node-c'].store.has('k5'));
});

test('quorum read: 503 when fewer than R nodes can answer', async (t) => {
  const { nodes, stop } = await startCluster(t);
  nodes['node-a'].store.applyRecord('k6', { value: 'only-here', expiresAt: null, version: 100, writer: 'node-a' });
  await stop('node-b');
  await stop('node-c');

  const res = await call(nodes['node-a'], '/keys/k6');
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.match(body.error, /read quorum not reached/);
  assert.equal(body.needed, 2);
  assert.equal(body.got, 1);
});

test('quorum read: a key nobody has is a normal 404', async (t) => {
  const { nodes } = await startCluster(t);
  const res = await call(nodes['node-b'], '/keys/does-not-exist');
  assert.equal(res.status, 404);
});