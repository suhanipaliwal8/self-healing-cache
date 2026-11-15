import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFailureDetectorConfig } from '../src/config.js';

test('heartbeat config: defaults are 1s interval, 0.5s timeout, 3 failures', () => {
  assert.deepEqual(loadFailureDetectorConfig({}), {
    intervalMs: 1000,
    timeoutMs: 500,
    failureThreshold: 3,
  });
});

test('heartbeat config: reads the environment variables', () => {
  const config = loadFailureDetectorConfig({
    HEARTBEAT_INTERVAL_MS: '200',
    HEARTBEAT_TIMEOUT_MS: '100',
    FAILURE_THRESHOLD: '5',
  });
  assert.deepEqual(config, { intervalMs: 200, timeoutMs: 100, failureThreshold: 5 });
});

test('heartbeat config: rejects values that are not whole numbers >= 1', () => {
  for (const name of ['HEARTBEAT_INTERVAL_MS', 'HEARTBEAT_TIMEOUT_MS', 'FAILURE_THRESHOLD']) {
    for (const bad of ['0', '-5', '1.5', 'abc', '']) {
      assert.throws(() => loadFailureDetectorConfig({ [name]: bad }), new RegExp(name));
    }
  }
});