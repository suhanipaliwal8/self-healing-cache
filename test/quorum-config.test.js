import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadQuorumConfig } from '../src/config.js';

const three = { replicationFactor: 3, replicationMode: 'sync' };

test('quorum config: defaults are 1 and 1 (the old behaviour)', () => {
  assert.deepEqual(loadQuorumConfig({}, three), { writeQuorum: 1, readQuorum: 1 });
});

test('quorum config: reads WRITE_QUORUM and READ_QUORUM', () => {
  const env = { WRITE_QUORUM: '2', READ_QUORUM: '3' };
  assert.deepEqual(loadQuorumConfig(env, three), { writeQuorum: 2, readQuorum: 3 });
});

test('quorum config: rejects values that are not whole numbers between 1 and N', () => {
  for (const bad of ['0', '-1', 'abc', '1.5', '4']) {
    assert.throws(
      () => loadQuorumConfig({ WRITE_QUORUM: bad }, three),
      /WRITE_QUORUM must be a whole number between 1 and REPLICATION_FACTOR/,
    );
  }
  assert.throws(
    () => loadQuorumConfig({ READ_QUORUM: '3' }, { replicationFactor: 2, replicationMode: 'sync' }),
    /READ_QUORUM must be a whole number between 1 and REPLICATION_FACTOR/,
  );
});

test('quorum config: a write quorum above 1 needs sync replication', () => {
  const asyncMode = { replicationFactor: 3, replicationMode: 'async' };
  assert.throws(() => loadQuorumConfig({ WRITE_QUORUM: '2' }, asyncMode), /needs REPLICATION_MODE=sync/);
  assert.deepEqual(loadQuorumConfig({ READ_QUORUM: '2' }, asyncMode), { writeQuorum: 1, readQuorum: 2 });
});