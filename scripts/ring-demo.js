import { HashRing, hash32 } from '../src/hash-ring.js';

const KEYS = 10_000;
const keys = Array.from({ length: KEYS }, (_, i) => `key-${i}`);

function percent(count) {
  return `${((count / KEYS) * 100).toFixed(1)}%`;
}

function ownersOf(ring) {
  return new Map(keys.map((key) => [key, ring.getNode(key)]));
}

// --- 1. How evenly are keys spread? ---
const ring = new HashRing({ vnodes: 100 });
for (const id of ['node-a', 'node-b', 'node-c']) ring.addNode(id);

const before = ownersOf(ring);
const counts = new Map();
for (const owner of before.values()) counts.set(owner, (counts.get(owner) ?? 0) + 1);

console.log(`Spread of ${KEYS} keys over 3 nodes (100 virtual nodes each):`);
for (const [id, count] of [...counts].sort()) {
  console.log(`  ${id}: ${count} keys (${percent(count)})`);
}

// --- 2. What happens when we add a 4th node? ---
ring.addNode('node-d');
const after = ownersOf(ring);
let moved = 0;
let movedToNewNode = 0;
for (const key of keys) {
  if (before.get(key) !== after.get(key)) {
    moved++;
    if (after.get(key) === 'node-d') movedToNewNode++;
  }
}

console.log('\nAdd node-d (consistent hashing):');
console.log(`  keys that moved: ${moved} (${percent(moved)})`);
console.log(`  ...and all of them moved to node-d: ${moved === movedToNewNode}`);

// --- 3. The same change with plain modulo hashing ---
let movedModulo = 0;
for (const key of keys) {
  if (hash32(key) % 3 !== hash32(key) % 4) movedModulo++;
}

console.log('\nGoing from 3 to 4 nodes with hash(key) % N (modulo hashing):');
console.log(`  keys that moved: ${movedModulo} (${percent(movedModulo)})`);