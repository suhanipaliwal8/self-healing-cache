import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadReplicationConfig } from '../src/config.js';

test('replication config: defaults to 2 copies, synchronous', () => {
  assert.deepEqual(loadReplicationConfig({}), { replicationFactor: 2, replicationMode: 'sync' });
});

test('replication config: reads REPLICATION_FACTOR and REPLICATION_MODE', () => {
  const config = loadReplicationConfig({ REPLICATION_FACTOR: '3', REPLICATION_MODE: 'async' });
  assert.deepEqual(config, { replicationFactor: 3, replicationMode: 'async' });
});

test('replication config: rejects an invalid factor', () => {
  for (const bad of ['0', '-1', '1.5', 'abc', '']) {
    assert.throws(() => loadReplicationConfig({ REPLICATION_FACTOR: bad }), /REPLICATION_FACTOR/);
  }
});

test('replication config: rejects an invalid mode', () => {
  assert.throws(() => loadReplicationConfig({ REPLICATION_MODE: 'fast' }), /REPLICATION_MODE/);
});