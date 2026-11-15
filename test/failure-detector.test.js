import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Cluster } from '../src/cluster.js';
import { FailureDetector } from '../src/failure-detector.js';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';

function makeCluster() {
  const cluster = new Cluster({ selfId: 'node-a' });
  cluster.addNode('node-a', 'http://localhost:3001');
  cluster.addNode('node-b', 'http://localhost:3002');
  cluster.addNode('node-c', 'http://localhost:3003');
  return cluster;
}

// A fake ping that answers from a table: results[id] = true (alive) or false.
function fakePing(results, calls = []) {
  return async (node) => {
    calls.push(node.id);
    return results[node.id];
  };
}

test('detector: a peer is marked down only after N failed pings in a row', async () => {
  const cluster = makeCluster();
  const changes = [];
  const detector = new FailureDetector({
    cluster,
    failureThreshold: 3,
    ping: fakePing({ 'node-b': false, 'node-c': true }),
    onChange: (id, status) => changes.push([id, status]),
  });

  await detector.checkOnce();
  await detector.checkOnce();
  assert.equal(cluster.isUp('node-b'), true); // 2 failures: not yet

  await detector.checkOnce();
  assert.equal(cluster.isUp('node-b'), false); // 3rd failure: down
  assert.deepEqual(changes, [['node-b', 'down']]);

  await detector.checkOnce(); // still down: no repeated notification
  assert.deepEqual(changes, [['node-b', 'down']]);
});

test('detector: one successful ping resets the failure count', async () => {
  const cluster = makeCluster();
  const results = { 'node-b': false, 'node-c': true };
  const detector = new FailureDetector({ cluster, failureThreshold: 3, ping: fakePing(results) });

  await detector.checkOnce();
  await detector.checkOnce();
  results['node-b'] = true; // a hiccup passes
  await detector.checkOnce();
  results['node-b'] = false;
  await detector.checkOnce();
  await detector.checkOnce();

  assert.equal(cluster.isUp('node-b'), true); // only 2 failures since the reset
});

test('detector: a down peer comes back up after one successful ping', async () => {
  const cluster = makeCluster();
  const changes = [];
  const results = { 'node-b': false, 'node-c': true };
  const detector = new FailureDetector({
    cluster,
    failureThreshold: 2,
    ping: fakePing(results),
    onChange: (id, status) => changes.push([id, status]),
  });

  await detector.checkOnce();
  await detector.checkOnce();
  assert.equal(cluster.isUp('node-b'), false);

  results['node-b'] = true;
  await detector.checkOnce();
  assert.equal(cluster.isUp('node-b'), true);
  assert.deepEqual(changes, [
    ['node-b', 'down'],
    ['node-b', 'up'],
  ]);
});

test('detector: never pings itself', async () => {
  const calls = [];
  const detector = new FailureDetector({
    cluster: makeCluster(),
    ping: fakePing({ 'node-b': true, 'node-c': true }, calls),
  });
  await detector.checkOnce();
  assert.deepEqual(calls.sort(), ['node-b', 'node-c']);
});

test('detector: every peer is tracked on its own', async () => {
  const cluster = makeCluster();
  const detector = new FailureDetector({
    cluster,
    failureThreshold: 2,
    ping: fakePing({ 'node-b': false, 'node-c': true }),
  });
  await detector.checkOnce();
  await detector.checkOnce();

  assert.equal(cluster.isUp('node-b'), false);
  assert.equal(cluster.isUp('node-c'), true);
});

test('detector: start() pings on a timer and stop() ends it', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const calls = [];
  const detector = new FailureDetector({
    cluster: makeCluster(),
    intervalMs: 1000,
    ping: fakePing({ 'node-b': true, 'node-c': true }, calls),
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  detector.start();
  assert.equal(calls.length, 0); // nothing until the first interval

  t.mock.timers.tick(1000);
  await settle();
  assert.equal(calls.length, 2); // node-b and node-c

  t.mock.timers.tick(1000);
  await settle();
  assert.equal(calls.length, 4);

  detector.stop();
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(calls.length, 4); // no more pings
});

test('detector: the real ping marks a frozen peer down and a healthy peer up', async (t) => {
  const healthy = createServer(new Store()); // answers /health
  const frozen = http.createServer(() => {}); // accepts connections, never answers
  for (const server of [healthy, frozen]) {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
  }

  const cluster = new Cluster({ selfId: 'node-a' });
  cluster.addNode('node-a', 'http://127.0.0.1:1'); // ourselves: never pinged
  cluster.addNode('healthy', `http://127.0.0.1:${healthy.address().port}`);
  cluster.addNode('frozen', `http://127.0.0.1:${frozen.address().port}`);

  const detector = new FailureDetector({ cluster, timeoutMs: 100, failureThreshold: 2 });
  await detector.checkOnce();
  await detector.checkOnce();

  assert.equal(cluster.isUp('healthy'), true);
  assert.equal(cluster.isUp('frozen'), false);
});