import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCluster, loadConfig } from '../src/config.js';

const CLUSTER = 'node-a=http://localhost:3001,node-b=http://localhost:3002';

test('config: parseCluster reads id=url pairs', () => {
  assert.deepEqual(parseCluster(` ${CLUSTER} `), [
    { id: 'node-a', url: 'http://localhost:3001' },
    { id: 'node-b', url: 'http://localhost:3002' },
  ]);
});

test('config: parseCluster of an empty value is an empty list', () => {
  assert.deepEqual(parseCluster(''), []);
  assert.deepEqual(parseCluster(undefined), []);
});

test('config: parseCluster rejects malformed entries', () => {
  assert.throws(() => parseCluster('node-a'), /expected id=url/);
  assert.throws(() => parseCluster('=http://x'), /expected id=url/);
  assert.throws(() => parseCluster('node-a='), /expected id=url/);
});

test('config: parseCluster rejects duplicate node ids', () => {
  assert.throws(() => parseCluster('a=http://x:1,a=http://x:2'), /Duplicate node id/);
});

test('config: without CLUSTER we run as a single node on PORT or 3000', () => {
  assert.deepEqual(loadConfig({}), { nodeId: 'node-1', port: 3000, nodes: [] });
  assert.equal(loadConfig({ PORT: '4000' }).port, 4000);
});

test('config: in a cluster the port comes from our own URL, PORT overrides it', () => {
  const base = { NODE_ID: 'node-b', CLUSTER };
  assert.equal(loadConfig(base).port, 3002);
  assert.equal(loadConfig({ ...base, PORT: '9999' }).port, 9999);
  assert.equal(loadConfig(base).nodes.length, 2);
});

test('config: NODE_ID must be listed in CLUSTER', () => {
  assert.throws(() => loadConfig({ NODE_ID: 'node-z', CLUSTER }), /not listed in CLUSTER/);
  assert.throws(() => loadConfig({ CLUSTER }), /not listed in CLUSTER/);
});