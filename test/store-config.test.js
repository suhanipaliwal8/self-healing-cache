import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadStoreConfig } from '../src/config.js';

test('store config: no MAX_ENTRIES means no limit', () => {
  assert.deepEqual(loadStoreConfig({}), { maxEntries: 0 });
  assert.deepEqual(loadStoreConfig({ MAX_ENTRIES: '' }), { maxEntries: 0 });
});

test('store config: reads MAX_ENTRIES', () => {
  assert.deepEqual(loadStoreConfig({ MAX_ENTRIES: '50' }), { maxEntries: 50 });
  assert.deepEqual(loadStoreConfig({ MAX_ENTRIES: '0' }), { maxEntries: 0 });
});

test('store config: rejects negative, non-numeric and fractional values', () => {
  for (const bad of ['-1', 'abc', '1.5']) {
    assert.throws(() => loadStoreConfig({ MAX_ENTRIES: bad }), /MAX_ENTRIES must be a whole number >= 0/);
  }
});