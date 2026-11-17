import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRebalanceConfig } from '../src/config.js';

test('rebalance config: default anti-entropy interval is 5000 ms', () => {
  assert.deepEqual(loadRebalanceConfig({}), { intervalMs: 5000 });
});

test('rebalance config: reads ANTI_ENTROPY_INTERVAL_MS', () => {
  assert.deepEqual(loadRebalanceConfig({ ANTI_ENTROPY_INTERVAL_MS: '250' }), { intervalMs: 250 });
});

test('rebalance config: rejects anything that is not a whole number >= 1', () => {
  for (const bad of ['0', '-5', 'abc', '1.5']) {
    assert.throws(() => loadRebalanceConfig({ ANTI_ENTROPY_INTERVAL_MS: bad }), /ANTI_ENTROPY_INTERVAL_MS/);
  }
});