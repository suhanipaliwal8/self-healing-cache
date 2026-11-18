import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Cluster } from '../src/cluster.js';
import { Rebalancer } from '../src/rebalancer.js';
import { createServer } from '../src/server.js';

async function startNode(id, maxEntries) {
  const store = new Store({ maxEntries });
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
  cluster.addNode(id, url);
  return { id, store, cluster, rebalancer, server, url };
}

test('lru in a cluster: a full node stays full, anti-entropy does not fight eviction, no key is lost', async (t) => {
  // node-c can only hold 10 keys, the others are unlimited.
  const nodes = [];
  for (const [id, max] of [['node-a', 0], ['node-b', 0], ['node-c', 10]]) {
    nodes.push(await startNode(id, max));
  }
  t.after(async () => {
    for (const node of nodes) {
      node.server.closeAllConnections();
      await new Promise((resolve) => node.server.close(resolve));
    }
  });
  for (const node of nodes) {
    for (const other of nodes) node.cluster.addNode(other.id, other.url);
  }
  const [a, b, c] = nodes;

  // 60 keys, 2 copies each = about 40 keys want to live on node-c.
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`${a.url}/keys/key-${i}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: `v${i}` }),
    });
    assert.equal(res.status, 200);
  }
  assert.equal(c.store.size, 10);
  assert.ok(c.store.stats.evictions > 0);
  const evictionsBefore = c.store.stats.evictions;

  // Anti-entropy tries to fill node-c again and again. It must NOT evict anything.
  for (let round = 0; round < 3; round++) {
    for (const node of nodes) await node.rebalancer.reconcile();
  }
  assert.equal(c.store.size, 10);
  assert.equal(c.store.stats.evictions, evictionsBefore);

  // Nothing is lost: the other copy and read-on-miss still serve every key.
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`${b.url}/keys/key-${i}`);
    assert.equal(res.status, 200, `key-${i} should still be readable`);
    assert.equal((await res.json()).value, `v${i}`);
  }
});