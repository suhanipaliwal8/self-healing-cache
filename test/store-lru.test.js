import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

function fakeClock(start = 1_000) {
  let time = start;
  const now = () => time;
  now.advance = (ms) => (time += ms);
  return now;
}

test('lru: when full, the least recently used key is evicted', () => {
  const store = new Store({ now: fakeClock(), maxEntries: 3 });
  store.set('a', 1);
  store.set('b', 2);
  store.set('c', 3);
  store.set('d', 4); // no room: "a" is the oldest

  assert.equal(store.has('a'), false);
  assert.equal(store.size, 3);
  assert.equal(store.stats.evictions, 1);
  assert.equal(store.get('d'), 4);
});

test('lru: reading a key makes it "recently used"', () => {
  const store = new Store({ now: fakeClock(), maxEntries: 3 });
  store.set('a', 1);
  store.set('b', 2);
  store.set('c', 3);
  assert.equal(store.get('a'), 1); // a is now the freshest
  store.set('d', 4); // so "b" is the one to go

  assert.equal(store.has('b'), false);
  assert.equal(store.has('a'), true);
  assert.equal(store.stats.evictions, 1);
});

test('lru: overwriting a key counts as use and does not grow the store', () => {
  const store = new Store({ now: fakeClock(), maxEntries: 3 });
  store.set('a', 1);
  store.set('b', 2);
  store.set('c', 3);
  store.set('a', 'new'); // same key: still 3 keys, and "a" is fresh again
  assert.equal(store.size, 3);
  assert.equal(store.stats.evictions, 0);

  store.set('d', 4);
  assert.equal(store.has('b'), false); // "b" was the oldest
  assert.equal(store.get('a'), 'new');
});

test('lru: no limit by default (maxEntries 0 means unlimited)', () => {
  const store = new Store({ now: fakeClock() });
  for (let i = 0; i < 1000; i++) store.set(`k${i}`, i);

  assert.equal(store.maxEntries, 0);
  assert.equal(store.room, Infinity);
  assert.equal(store.size, 1000);
  assert.equal(store.stats.evictions, 0);
});

test('lru: tombstones are not counted and are never evicted', () => {
  const store = new Store({ now: fakeClock(), maxEntries: 2 });
  store.set('a', 1);
  store.set('b', 2);
  store.delete('a'); // leaves a tombstone, only "b" is live
  assert.equal(store.size, 1);

  store.set('c', 3); // 2 live keys: still fits
  assert.equal(store.stats.evictions, 0);

  store.set('d', 4); // 3 live keys: must evict the oldest LIVE key ("b")
  assert.equal(store.stats.evictions, 1);
  assert.equal(store.has('b'), false);
  assert.equal(store.size, 2);
  assert.equal(store.getRecord('a').deleted, true); // the tombstone survived
});

test('lru: room goes down with new keys and up with deletes and sweeps', () => {
  const now = fakeClock();
  const store = new Store({ now, maxEntries: 3 });
  assert.equal(store.room, 3);

  store.set('a', 1);
  store.set('b', 2);
  assert.equal(store.room, 1);

  store.delete('a');
  assert.equal(store.room, 2);

  store.set('c', 3, { ttlMs: 100 });
  assert.equal(store.room, 1);

  now.advance(200); // "c" has expired
  assert.equal(store.sweep(), 1);
  assert.equal(store.room, 2); // only "b" is live
});

test('lru: applyRecord with evict:false refuses NEW keys when full, but accepts updates and tombstones', () => {
  const store = new Store({ now: fakeClock(), maxEntries: 2 });
  store.set('a', 1);
  store.set('b', 2);
  const record = { value: 'x', expiresAt: null, version: 5_000, writer: 'w' };

  // a brand new key does not fit: refused, and nobody is evicted
  assert.equal(store.applyRecord('c', record, { evict: false }), false);
  assert.equal(store.has('c'), false);
  assert.equal(store.size, 2);
  assert.equal(store.stats.evictions, 0);

  // a newer version of a key we already hold is fine
  assert.equal(store.applyRecord('a', record, { evict: false }), true);
  assert.equal(store.get('a'), 'x');

  // tombstones take no room, so they are accepted
  const tombstone = { deleted: true, expiresAt: null, version: 5_000, writer: 'w' };
  assert.equal(store.applyRecord('zz', tombstone, { evict: false }), true);
  assert.equal(store.getRecord('zz').deleted, true);

  // the normal way (evict allowed) makes room by evicting the oldest key
  assert.equal(store.applyRecord('c', record), true);
  assert.equal(store.has('c'), true);
  assert.equal(store.size, 2);
  assert.equal(store.stats.evictions, 1);
});

test('lru: has() and getRecord() do not count as use (so anti-entropy cannot disturb the order)', () => {
  const store = new Store({ now: fakeClock(), maxEntries: 3 });
  store.set('a', 1);
  store.set('b', 2);
  store.set('c', 3);

  store.has('a');
  store.getRecord('a');
  [...store.records()]; // what a digest does

  store.set('d', 4); // "a" is STILL the oldest
  assert.equal(store.getRecord('a'), undefined);
  assert.equal(store.has('b'), true);
});

test('lru: maxEntries must be a whole number >= 0', () => {
  assert.throws(() => new Store({ maxEntries: -1 }), /maxEntries must be a whole number >= 0/);
  assert.throws(() => new Store({ maxEntries: 1.5 }), /maxEntries must be a whole number >= 0/);
  assert.throws(() => new Store({ maxEntries: 'ten' }), /maxEntries must be a whole number >= 0/);
  assert.doesNotThrow(() => new Store({ maxEntries: 0 }));
});