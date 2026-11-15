import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cluster } from '../src/cluster.js';

function makeCluster(selfId) {
  const cluster = new Cluster({ selfId });
  cluster.addNode('node-a', 'http://localhost:3001');
  cluster.addNode('node-b', 'http://localhost:3002');
  cluster.addNode('node-c', 'http://localhost:3003');
  return cluster;
}

test('cluster: an empty cluster has no owner', () => {
  assert.equal(new Cluster({ selfId: 'node-a' }).ownerOf('k'), undefined);
});

test('cluster: ownerOf returns id, url and whether the owner is us', () => {
  const cluster = makeCluster('node-a');
  for (let i = 0; i < 200; i++) {
    const owner = cluster.ownerOf(`key-${i}`);
    assert.equal(owner.url, `http://localhost:300${'abc'.indexOf(owner.id.slice(-1)) + 1}`);
    assert.equal(owner.isSelf, owner.id === 'node-a');
  }
});

test('cluster: every node computes the same owner for every key', () => {
  const [a, b, c] = ['node-a', 'node-b', 'node-c'].map(makeCluster);
  for (let i = 0; i < 1_000; i++) {
    const key = `key-${i}`;
    assert.equal(a.ownerOf(key).id, b.ownerOf(key).id);
    assert.equal(b.ownerOf(key).id, c.ownerOf(key).id);
  }
});


test('cluster: ownersOf returns distinct nodes and starts with the owner', () => {
  const cluster = makeCluster('node-a');
  for (let i = 0; i < 300; i++) {
    const key = `key-${i}`;
    const owners = cluster.ownersOf(key, 2);
    assert.equal(owners.length, 2);
    assert.notEqual(owners[0].id, owners[1].id);
    assert.equal(owners[0].id, cluster.ownerOf(key).id);
    assert.equal(owners[1].isSelf, owners[1].id === 'node-a');
  }
});

test('cluster: ownersOf never returns more nodes than exist', () => {
  const cluster = makeCluster('node-a');
  assert.equal(cluster.ownersOf('k', 10).length, 3);
  assert.deepEqual(new Cluster({ selfId: 'x' }).ownersOf('k', 2), []);
});


test('cluster: markDown and markUp change isUp, but we never mark ourselves down', () => {
  const cluster = makeCluster('node-a');
  assert.equal(cluster.isUp('node-b'), true);

  cluster.markDown('node-b');
  assert.equal(cluster.isUp('node-b'), false);
  cluster.markUp('node-b');
  assert.equal(cluster.isUp('node-b'), true);

  cluster.markDown('node-a'); // ourselves: ignored
  cluster.markDown('ghost'); // unknown node: ignored
  assert.equal(cluster.isUp('node-a'), true);
  assert.equal(cluster.isUp('ghost'), true);
});

test('cluster: a down node stays on the ring, so key owners do not change', () => {
  const cluster = makeCluster('node-a');
  const before = Array.from({ length: 300 }, (_, i) => cluster.ownersOf(`key-${i}`, 2).map((o) => o.id));
  cluster.markDown('node-b');
  const after = Array.from({ length: 300 }, (_, i) => cluster.ownersOf(`key-${i}`, 2).map((o) => o.id));
  assert.deepEqual(after, before);
});

test('cluster: nodes and ownersOf report who is up or down', () => {
  const cluster = makeCluster('node-a');
  cluster.markDown('node-c');

  const status = Object.fromEntries(cluster.nodes.map((n) => [n.id, n.status]));
  assert.deepEqual(status, { 'node-a': 'up', 'node-b': 'up', 'node-c': 'down' });

  const flags = cluster.ownersOf('anything', 3).map((o) => [o.id, o.isUp]);
  assert.deepEqual(flags.find(([id]) => id === 'node-c'), ['node-c', false]);
  assert.deepEqual(flags.find(([id]) => id === 'node-b'), ['node-b', true]);
});