import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Cluster } from '../src/cluster.js';
import { Rebalancer } from '../src/rebalancer.js';
import { createServer } from '../src/server.js';

// Starts one node (own store, cluster view, rebalancer and HTTP server).
async function startNode(id) {
  const store = new Store();
  const cluster = new Cluster({ selfId: id });
  const rebalancer = new Rebalancer({ store, cluster, replicationFactor: 2, timeoutMs: 500 });
  const server = createServer(store, {
    cluster,
    forwardTimeoutMs: 500,
    replicationFactor: 2,
    rebalancer,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  cluster.addNode(id, url); // every node knows at least itself
  return { id, store, cluster, rebalancer, server, url, running: true };
}

// A cluster that starts with node-a, node-b, node-c (all knowing each other).
async function startCluster() {
  const nodes = new Map();
  for (const id of ['node-a', 'node-b', 'node-c']) nodes.set(id, await startNode(id));
  for (const node of nodes.values()) {
    for (const other of nodes.values()) node.cluster.addNode(other.id, other.url);
  }
  return {
    nodes,
    node: (id) => nodes.get(id),
    // owners of a key according to node-a's view of the cluster
    owners: (key) => nodes.get('node-a').cluster.ownersOf(key, 2).map((o) => o.id),
    holders: (key) => [...nodes.values()].filter((n) => n.running && n.store.has(key)).map((n) => n.id).sort(),
    async join(id) {
      const node = await startNode(id); // knows only itself
      nodes.set(id, node);
      return node;
    },
    wipe(id) {
      // like a node that restarted: it comes back with an empty memory
      const { store } = nodes.get(id);
      for (const [key, record] of [...store.records()]) store.removeIfUnchanged(key, record);
    },
    async stop(id) {
      const node = nodes.get(id);
      if (!node.running) return;
      node.running = false;
      node.server.closeAllConnections();
      await new Promise((resolve) => node.server.close(resolve));
    },
    async stopAll() {
      for (const id of nodes.keys()) await this.stop(id);
    },
  };
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

async function fillKeys(c, count) {
  for (let i = 0; i < count; i++) {
    const res = await call(c.node('node-a'), `/keys/key-${i}`, { method: 'PUT', body: { value: `v${i}` } });
    assert.equal(res.status, 200);
  }
}

// ---------- empty or stale nodes ----------

test('catch-up: a node that restarted empty still answers reads (no false 404)', async (t) => {
  const c = await startCluster();
  t.after(() => c.stopAll());
  await call(c.node('node-a'), '/keys/user:1', { method: 'PUT', body: { value: 'alice' } });

  const [primary] = c.owners('user:1');
  c.wipe(primary); // the primary "restarted" and lost its memory
  assert.equal(c.node(primary).store.has('user:1'), false);

  const coordinator = ['node-a', 'node-b', 'node-c'].find((id) => id !== primary);
  const res = await call(c.node(coordinator), '/keys/user:1');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).value, 'alice'); // the replica answered
});

test('catch-up: a truly missing key is still a 404', async (t) => {
  const c = await startCluster();
  t.after(() => c.stopAll());
  const res = await call(c.node('node-b'), '/keys/nothing-here');
  assert.equal(res.status, 404);
});

test('catch-up: reconcile refills a node that came back empty', async (t) => {
  const c = await startCluster();
  t.after(() => c.stopAll());
  await fillKeys(c, 30);

  c.wipe('node-c');
  assert.equal(c.node('node-c').store.size, 0);
  await c.node('node-c').rebalancer.reconcile(); // node-c asks its peers

  for (let i = 0; i < 30; i++) {
    const key = `key-${i}`;
    assert.deepEqual(c.holders(key), c.owners(key).sort(), `${key} should be on exactly its owners`);
  }
});

test('catch-up: peers push the data to a returning node (they notice it is back)', async (t) => {
  const c = await startCluster();
  t.after(() => c.stopAll());
  await fillKeys(c, 30);
  c.wipe('node-c');

  await c.node('node-a').rebalancer.reconcile(); // what node-a does when it sees node-c "up" again
  await c.node('node-b').rebalancer.reconcile();
  const ownedByC = Array.from({ length: 30 }, (_, i) => `key-${i}`).filter((k) => c.owners(k).includes('node-c'));
  assert.ok(ownedByC.length > 0);
  for (const key of ownedByC) assert.equal(c.node('node-c').store.has(key), true);
});

test('versions: a node that missed a write gets the newer value, not the other way round', async (t) => {
  const c = await startCluster();
  t.after(() => c.stopAll());
  const key = 'user:1';
  const [primary, replica] = c.owners(key);

  await call(c.node(primary), `/keys/${key}`, { method: 'PUT', body: { value: 'new' } });
  // the replica holds an OLD copy (it missed the update)
  c.wipe(replica);
  c.node(replica).store.set(key, 'old', { version: 1, writer: 'node-z' });

  await c.node(primary).rebalancer.reconcile();
  assert.equal(c.node(replica).store.get(key), 'new');
  assert.equal(c.node(primary).store.get(key), 'new'); // and the newer value was never overwritten
});

test('versions: the internal endpoint ignores an older write', async (t) => {
  const c = await startCluster();
  t.after(() => c.stopAll());
  const node = c.node('node-a');
  const put = (version, value) =>
    call(node, '/internal/keys/k', { method: 'PUT', body: { value, expiresAt: null, version, writer: 'x' } });

  assert.deepEqual(await (await put(20, 'new')).json(), { ok: true, applied: true });
  assert.deepEqual(await (await put(10, 'old')).json(), { ok: true, applied: false });
  assert.equal(node.store.get('k'), 'new');
});

test('tombstone: a node that missed a delete does not bring the key back', async (t) => {
  const c = await startCluster();
  t.after(() => c.stopAll());
  const key = 'user:1';
  const [primary, replica] = c.owners(key);
  await call(c.node(primary), `/keys/${key}`, { method: 'PUT', body: { value: 'alice' } });
  const old = c.node(replica).store.getRecord(key);

  await call(c.node(primary), `/keys/${key}`, { method: 'DELETE' });
  // pretend the replica was down and still has the old value
  c.wipe(replica);
  c.node(replica).store.set(key, 'alice', { version: old.version, writer: old.writer });
  assert.equal(c.node(replica).store.has(key), true);

  await c.node(primary).rebalancer.reconcile();
  assert.equal(c.node(replica).store.has(key), false); // the tombstone reached it
  for (const id of ['node-a', 'node-b', 'node-c']) {
    assert.equal((await call(c.node(id), `/keys/${key}`)).status, 404);
  }
});

// ---------- joining and leaving ----------

test('join: a new node gets its share of the keys and nobody holds extra copies', async (t) => {
  const c = await startCluster();
  t.after(() => c.stopAll());
  await fillKeys(c, 60);
  const dBefore = c.node('node-a').cluster.nodes.length;
  assert.equal(dBefore, 3);

  const d = await c.join('node-d');
  const res = await call(c.node('node-a'), '/cluster/nodes/node-d', { method: 'PUT', body: { url: d.url } });
  assert.equal(res.status, 200);

  // every node learned about node-d, and node-d learned about everybody
  for (const node of c.nodes.values()) assert.equal(node.cluster.nodes.length, 4);

  const keys = Array.from({ length: 60 }, (_, i) => `key-${i}`);
  await waitFor(() => keys.every((k) => JSON.stringify(c.holders(k)) === JSON.stringify(c.owners(k).sort())));

  const onD = keys.filter((k) => d.store.has(k));
  assert.ok(onD.length > 0, 'node-d should own some keys');
  assert.ok(onD.length < keys.length, 'node-d should not own all keys');
  // every key is still readable through any node
  for (const key of keys) {
    const got = await call(c.node('node-b'), `/keys/${key}`);
    assert.equal(got.status, 200, key);
  }
});

test('join: only a fraction of the keys move to the new node (consistent hashing at work)', async (t) => {
  const c = await startCluster();
  t.after(() => c.stopAll());
  await fillKeys(c, 100);
  const primariesBefore = new Map(Array.from({ length: 100 }, (_, i) => [`key-${i}`, c.owners(`key-${i}`)[0]]));

  const d = await c.join('node-d');
  await call(c.node('node-a'), '/cluster/nodes/node-d', { method: 'PUT', body: { url: d.url } });

  let moved = 0;
  for (const [key, before] of primariesBefore) if (c.owners(key)[0] !== before) moved++;
  assert.ok(moved > 5 && moved < 50, `expected roughly a quarter to move, got ${moved} of 100`);
});

test('leave: when a node is removed the remaining nodes restore two copies of every key', async (t) => {
  const c = await startCluster();
  t.after(() => c.stopAll());
  await fillKeys(c, 60);

  await c.stop('node-c'); // node-c is gone for good
  const res = await call(c.node('node-a'), '/cluster/nodes/node-c', { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.deepEqual(c.node('node-b').cluster.nodes.map((n) => n.id).sort(), ['node-a', 'node-b']);

  const keys = Array.from({ length: 60 }, (_, i) => `key-${i}`);
  // with only 2 nodes left, every key must be on BOTH of them
  await waitFor(() => keys.every((k) => c.holders(k).join() === 'node-a,node-b'));
  for (const key of keys) {
    const got = await call(c.node('node-a'), `/keys/${key}`);
    assert.equal((await got.json()).value, `v${key.split('-')[1]}`);
  }
});

test('leave: a node that is told to leave hands its keys over before forgetting them', async (t) => {
  const c = await startCluster();
  t.after(() => c.stopAll());
  await fillKeys(c, 40);

  await call(c.node('node-a'), '/cluster/nodes/node-c', { method: 'DELETE' }); // node-c is still alive
  const keys = Array.from({ length: 40 }, (_, i) => `key-${i}`);
  await waitFor(() => keys.every((k) => c.holders(k).join() === 'node-a,node-b'));
  assert.equal(c.node('node-c').store.size, 0); // node-c gave everything away
});

test('rebalance: a key is NOT dropped while one of its new owners is unreachable', async (t) => {
  const c = await startCluster();
  t.after(() => c.stopAll());
  await fillKeys(c, 60);
  const d = await c.join('node-d');
  // node-a learns about node-d, but node-d is stopped before it can receive anything
  c.node('node-a').cluster.addNode('node-d', d.url);
  await c.stop('node-d');
  c.node('node-a').cluster.markDown('node-d');

  const before = c.node('node-a').store.size;
  await c.node('node-a').rebalancer.reconcile();
  assert.equal(c.node('node-a').store.size, before); // nothing was thrown away
  assert.equal(c.node('node-a').rebalancer.stats.dropped, 0);
});

test('membership: rejects a bad body and ignores a repeated add', async (t) => {
  const c = await startCluster();
  t.after(() => c.stopAll());
  const a = c.node('node-a');

  const bad = await call(a, '/cluster/nodes/node-x', { method: 'PUT', body: { url: 'not a url' } });
  assert.equal(bad.status, 400);
  assert.equal(a.cluster.nodes.length, 3);

  const d = await c.join('node-d');
  for (let i = 0; i < 2; i++) {
    await call(a, '/cluster/nodes/node-d', { method: 'PUT', body: { url: d.url } });
  }
  assert.equal(a.cluster.nodes.length, 4); // added once
});

test('rebalancer: rounds that overlap are merged, and anti-entropy runs on a timer', async (t) => {
  const c = await startCluster();
  t.after(() => c.stopAll());
  const rebalancer = c.node('node-a').rebalancer;

  await Promise.all([rebalancer.reconcile(), rebalancer.reconcile(), rebalancer.reconcile()]);
  assert.ok(rebalancer.stats.rounds <= 2, `three requests should need at most 2 rounds, got ${rebalancer.stats.rounds}`);

  await fillKeys(c, 10);
  c.wipe('node-b');
  c.node('node-b').rebalancer.start(50); // anti-entropy every 50 ms
  t.after(() => c.node('node-b').rebalancer.stop());
  await waitFor(() => c.node('node-b').store.size > 0);
});