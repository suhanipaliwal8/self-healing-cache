import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HashRing, hash32 } from '../src/hash-ring.js';

const KEYS = Array.from({ length: 10_000 }, (_, i) => `key-${i}`);

function makeRing(nodeIds) {
  const ring = new HashRing({ vnodes: 100 });
  for (const id of nodeIds) ring.addNode(id);
  return ring;
}

function ownersOf(ring) {
  return new Map(KEYS.map((key) => [key, ring.getNode(key)]));
}

test('hash32: is deterministic and stays inside the unsigned 32-bit range', () => {
  assert.equal(hash32('hello'), hash32('hello'));
  for (const key of KEYS.slice(0, 1_000)) {
    const h = hash32(key);
    assert.ok(Number.isInteger(h) && h >= 0 && h <= 4_294_967_295);
  }
});

test('ring: an empty ring has no owner', () => {
  const ring = new HashRing();
  assert.equal(ring.getNode('a'), undefined);
  assert.deepEqual(ring.getNodes('a', 2), []);
});

test('ring: the same key always maps to the same node', () => {
  const ring = makeRing(['node-a', 'node-b', 'node-c']);
  const first = ring.getNode('user:42');
  for (let i = 0; i < 100; i++) {
    assert.equal(ring.getNode('user:42'), first);
  }
});

test('ring: a single node owns every key', () => {
  const ring = makeRing(['only']);
  for (const key of KEYS.slice(0, 500)) {
    assert.equal(ring.getNode(key), 'only');
  }
});

test('ring: keys spread reasonably evenly over 3 nodes', () => {
  const ring = makeRing(['node-a', 'node-b', 'node-c']);
  const counts = new Map();
  for (const owner of ownersOf(ring).values()) {
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }
  assert.equal(counts.size, 3);
  for (const count of counts.values()) {
    // a perfect split is 33.3%; allow 25% to 42%
    assert.ok(count > 2_500 && count < 4_200, `unbalanced: ${count}`);
  }
});

test('ring: adding a node only moves keys TO the new node, and not many', () => {
  const ring = makeRing(['node-a', 'node-b', 'node-c']);
  const before = ownersOf(ring);
  ring.addNode('node-d');
  const after = ownersOf(ring);

  let moved = 0;
  for (const key of KEYS) {
    if (before.get(key) !== after.get(key)) {
      moved++;
      assert.equal(after.get(key), 'node-d', `${key} moved somewhere unexpected`);
    }
  }
  // ideal is 25% (1 of 4 nodes); allow up to 35%
  assert.ok(moved > 0 && moved < 3_500, `moved ${moved}`);
});

test('ring: removing a node only moves the keys that node owned', () => {
  const ring = makeRing(['node-a', 'node-b', 'node-c', 'node-d']);
  const before = ownersOf(ring);
  ring.removeNode('node-c');
  const after = ownersOf(ring);

  for (const key of KEYS) {
    if (before.get(key) === 'node-c') {
      assert.notEqual(after.get(key), 'node-c');
    } else {
      assert.equal(after.get(key), before.get(key), `${key} should not have moved`);
    }
  }
});

test('ring: getNodes returns distinct nodes and the first is the owner', () => {
  const ring = makeRing(['node-a', 'node-b', 'node-c']);
  for (const key of KEYS.slice(0, 500)) {
    const nodes = ring.getNodes(key, 2);
    assert.equal(nodes.length, 2);
    assert.notEqual(nodes[0], nodes[1]);
    assert.equal(nodes[0], ring.getNode(key));
  }
});

test('ring: getNodes never returns more nodes than exist', () => {
  const ring = makeRing(['node-a', 'node-b']);
  assert.equal(ring.getNodes('k', 5).length, 2);
});

test('ring: adding the same node twice or removing an unknown node does nothing', () => {
  const ring = makeRing(['node-a']);
  ring.addNode('node-a');
  ring.removeNode('ghost');
  assert.deepEqual(ring.nodes, ['node-a']);
  assert.equal(ring.size, 1);
});

test('ring vs modulo: adding a node moves far fewer keys than hash % N', () => {
  const ring = makeRing(['node-a', 'node-b', 'node-c']);
  const before = ownersOf(ring);
  ring.addNode('node-d');
  const after = ownersOf(ring);

  let movedRing = 0;
  let movedModulo = 0;
  for (const key of KEYS) {
    if (before.get(key) !== after.get(key)) movedRing++;
    if (hash32(key) % 3 !== hash32(key) % 4) movedModulo++;
  }
  assert.ok(movedModulo > 6_000, `modulo moved ${movedModulo}`); // about 75%
  assert.ok(movedRing < 3_500, `ring moved ${movedRing}`); // about 25%
});