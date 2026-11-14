import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

test('store: set then get returns the value', () => {
  const store = new Store();
  store.set('name', 'alice');
  assert.equal(store.get('name'), 'alice');
});

test('store: get on a missing key returns undefined', () => {
  const store = new Store();
  assert.equal(store.get('nope'), undefined);
});

test('store: set overwrites an existing key', () => {
  const store = new Store();
  store.set('name', 'alice');
  store.set('name', 'bob');
  assert.equal(store.get('name'), 'bob');
  assert.equal(store.size, 1);
});

test('store: delete removes an existing key and returns true', () => {
  const store = new Store();
  store.set('name', 'alice');
  assert.equal(store.delete('name'), true);
  assert.equal(store.has('name'), false);
});

test('store: delete on a missing key returns false', () => {
  const store = new Store();
  assert.equal(store.delete('nope'), false);
});


// ---- TTL tests (Phase 2) ----
// A fake clock lets us "travel in time" instead of waiting for real seconds.
function makeClock(start = 1_000) {
  const clock = { time: start, now: () => clock.time };
  return clock;
}

test('store ttl: key is readable before it expires', () => {
  const clock = makeClock();
  const store = new Store({ now: clock.now });
  store.set('a', 1, { ttlMs: 5_000 });
  clock.time += 4_999;
  assert.equal(store.get('a'), 1);
});

test('store ttl: key is gone once its time is up', () => {
  const clock = makeClock();
  const store = new Store({ now: clock.now });
  store.set('a', 1, { ttlMs: 5_000 });
  clock.time += 5_000;
  assert.equal(store.get('a'), undefined);
  assert.equal(store.has('a'), false);
});

test('store ttl: delete on an expired key returns false', () => {
  const clock = makeClock();
  const store = new Store({ now: clock.now });
  store.set('a', 1, { ttlMs: 1_000 });
  clock.time += 2_000;
  assert.equal(store.delete('a'), false);
});

test('store ttl: set without ttl clears an old ttl', () => {
  const clock = makeClock();
  const store = new Store({ now: clock.now });
  store.set('a', 1, { ttlMs: 1_000 });
  store.set('a', 2);
  clock.time += 10_000;
  assert.equal(store.get('a'), 2);
});

test('store ttl: expiresAt sets an absolute expiry time', () => {
  const clock = makeClock(1_000);
  const store = new Store({ now: clock.now });
  store.set('a', 1, { expiresAt: 3_000 });
  assert.deepEqual(store.getEntry('a'), { value: 1, expiresAt: 3_000 });
  clock.time = 3_000;
  assert.equal(store.getEntry('a'), undefined);
});

test('store ttl: getEntry shows expiresAt as null for keys without ttl', () => {
  const store = new Store();
  store.set('a', 1);
  assert.deepEqual(store.getEntry('a'), { value: 1, expiresAt: null });
});

test('store ttl: sweep removes only expired keys and returns the count', () => {
  const clock = makeClock();
  const store = new Store({ now: clock.now });
  store.set('short', 1, { ttlMs: 1_000 });
  store.set('long', 2, { ttlMs: 60_000 });
  store.set('forever', 3);
  clock.time += 2_000;
  assert.equal(store.size, 3); // nobody asked yet, so nothing was removed
  assert.equal(store.sweep(), 1);
  assert.equal(store.size, 2);
});