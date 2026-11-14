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