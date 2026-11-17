import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, isNewer } from '../src/store.js';

function fakeClock(start = 1_000) {
  let time = start;
  const now = () => time;
  now.advance = (ms) => (time += ms);
  return now;
}

test('versions: isNewer compares version first, then writer name as a tie-break', () => {
  assert.equal(isNewer({ version: 2 }, { version: 1 }), true);
  assert.equal(isNewer({ version: 1 }, { version: 2 }), false);
  assert.equal(isNewer({ version: 1, writer: 'node-b' }, { version: 1, writer: 'node-a' }), true);
  assert.equal(isNewer({ version: 1, writer: 'node-a' }, { version: 1, writer: 'node-b' }), false);
  assert.equal(isNewer({ version: 1, writer: 'node-a' }, { version: 1, writer: 'node-a' }), false);
  assert.equal(isNewer({ version: 1 }, undefined), true);
});

test('versions: a plain set gets a version that always goes up', () => {
  const now = fakeClock(5_000);
  const store = new Store({ now });
  store.set('a', 1);
  const first = store.getRecord('a').version;
  store.set('a', 2); // same millisecond
  assert.ok(store.getRecord('a').version > first);
});

test('versions: applyRecord keeps the newer record and ignores the older one', () => {
  const store = new Store({ now: fakeClock() });
  assert.equal(store.applyRecord('a', { value: 'new', expiresAt: null, version: 20, writer: 'x' }), true);
  assert.equal(store.applyRecord('a', { value: 'old', expiresAt: null, version: 10, writer: 'x' }), false);
  assert.equal(store.get('a'), 'new');
  assert.equal(store.applyRecord('a', { value: 'new', expiresAt: null, version: 20, writer: 'x' }), false); // same one again
  assert.equal(store.applyRecord('a', { value: 'newest', expiresAt: null, version: 30, writer: 'x' }), true);
  assert.equal(store.get('a'), 'newest');
});

test('tombstone: delete leaves a record so an older copy cannot bring the key back', () => {
  const store = new Store({ now: fakeClock() });
  store.set('a', 'v', { version: 10, writer: 'x' });
  assert.equal(store.delete('a', { version: 20, writer: 'x' }), true);
  assert.equal(store.has('a'), false);
  assert.equal(store.getRecord('a').deleted, true);
  // an old copy of the value shows up late (for example from a node that was down)
  assert.equal(store.applyRecord('a', { value: 'v', expiresAt: null, version: 10, writer: 'x' }), false);
  assert.equal(store.has('a'), false);
});

test('tombstone: a write newer than the delete replaces the tombstone', () => {
  const store = new Store({ now: fakeClock() });
  store.delete('a', { version: 20, writer: 'x' });
  assert.equal(store.applyRecord('a', { value: 'again', expiresAt: null, version: 30, writer: 'x' }), true);
  assert.equal(store.get('a'), 'again');
});

test('tombstone: deleting a missing key returns false but still leaves a tombstone', () => {
  const store = new Store({ now: fakeClock() });
  assert.equal(store.delete('ghost', { version: 5, writer: 'x' }), false);
  assert.equal(store.getRecord('ghost').deleted, true);
  assert.equal(store.size, 0); // tombstones are not counted as keys
});

test('tombstone: it is cleaned up after the tombstone lifetime', () => {
  const now = fakeClock();
  const store = new Store({ now, tombstoneTtlMs: 1_000 });
  store.delete('a', { version: 5, writer: 'x' });
  assert.ok(store.getRecord('a'));
  now.advance(1_001);
  assert.equal(store.sweep(), 1);
  assert.equal(store.getRecord('a'), undefined);
});

test('versions: a record that already expired is not stored', () => {
  const now = fakeClock(5_000);
  const store = new Store({ now });
  assert.equal(store.applyRecord('a', { value: 1, expiresAt: 4_000, version: 1, writer: 'x' }), false);
  assert.equal(store.getRecord('a'), undefined);
});

test('versions: removeIfUnchanged forgets a key only if nobody wrote a newer version', () => {
  const store = new Store({ now: fakeClock() });
  store.set('a', 1, { version: 10, writer: 'x' });
  store.set('a', 2, { version: 11, writer: 'x' }); // written after we looked
  assert.equal(store.removeIfUnchanged('a', { version: 10, writer: 'x' }), false);
  assert.equal(store.get('a'), 2);
  assert.equal(store.removeIfUnchanged('a', { version: 11, writer: 'x' }), true);
  assert.equal(store.getRecord('a'), undefined); // gone completely, no tombstone
});