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