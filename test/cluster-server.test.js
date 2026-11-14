import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Cluster } from '../src/cluster.js';
import { createServer } from '../src/server.js';

const IDS = ['node-a', 'node-b', 'node-c'];
const nodes = new Map(); // id -> { store, server, url }

before(async () => {
  // 1. Start every node on a free port (the ports are not known up front).
  for (const id of IDS) {
    const store = new Store();
    const cluster = new Cluster({ selfId: id });
    const server = createServer(store, { cluster, forwardTimeoutMs: 500 });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    nodes.set(id, { store, server, cluster, url: `http://127.0.0.1:${server.address().port}` });
  }
  // 2. Now that the ports exist, tell every node about every node.
  for (const { cluster } of nodes.values()) {
    for (const [id, { url }] of nodes) cluster.addNode(id, url);
  }
});

after(async () => {
  for (const { server } of nodes.values()) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

function request(id, key, { method = 'GET', body, headers = {} } = {}) {
  return fetch(`${nodes.get(id).url}/keys/${key}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function ownerOf(key) {
  return nodes.get('node-a').cluster.ownerOf(key).id;
}

test('cluster server: a key written via any node can be read via every node', async () => {
  const put = await request('node-a', 'shared', { method: 'PUT', body: { value: 'hello' } });
  assert.equal(put.status, 200);

  for (const id of IDS) {
    const res = await request(id, 'shared');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { key: 'shared', value: 'hello' });
  }
});

test('cluster server: the key is stored on its owner and nowhere else', async () => {
  await request('node-b', 'where-am-i', { method: 'PUT', body: { value: 1 } });

  const holders = IDS.filter((id) => nodes.get(id).store.has('where-am-i'));
  assert.deepEqual(holders, [ownerOf('where-am-i')]);
});

test('cluster server: x-served-by shows the owner answered', async () => {
  await request('node-a', 'who-served', { method: 'PUT', body: { value: 1 } });
  for (const id of IDS) {
    const res = await request(id, 'who-served');
    assert.equal(res.headers.get('x-served-by'), ownerOf('who-served'));
  }
});

test('cluster server: DELETE through a non-owner deletes on the owner', async () => {
  const key = 'to-delete';
  await request('node-a', key, { method: 'PUT', body: { value: 1 } });
  const other = IDS.find((id) => id !== ownerOf(key));

  const del = await request(other, key, { method: 'DELETE' });
  assert.deepEqual(await del.json(), { deleted: true });
  assert.equal(nodes.get(ownerOf(key)).store.has(key), false);
});

test('cluster server: ttl survives forwarding', async () => {
  const key = 'with-ttl';
  const other = IDS.find((id) => id !== ownerOf(key));
  await request(other, key, { method: 'PUT', body: { value: 'x', ttl: 60 } });

  const res = await request(other, key);
  const body = await res.json();
  assert.equal(body.value, 'x');
  assert.ok(body.expiresAt > Date.now());
});

test('cluster server: a forwarded request is handled locally, never re-forwarded', async () => {
  const key = 'loop-guard';
  const notOwner = IDS.find((id) => id !== ownerOf(key));

  await request(notOwner, key, {
    method: 'PUT',
    body: { value: 'here' },
    headers: { 'x-cache-forwarded-by': 'someone' },
  });
  assert.equal(nodes.get(notOwner).store.get(key), 'here');
});

test('cluster server: GET /cluster lists the nodes this node knows', async () => {
  const res = await fetch(`${nodes.get('node-c').url}/cluster`);
  const body = await res.json();
  assert.equal(body.self, 'node-c');
  assert.deepEqual(body.nodes.map((n) => n.id).sort(), IDS);
});

test('cluster server: an unreachable owner gives 502', async () => {
  // Find a key owned by node-c, then stop node-c and ask node-a for it.
  let key = 'probe-0';
  for (let i = 1; ownerOf(key) !== 'node-c'; i++) key = `probe-${i}`;

  const dead = nodes.get('node-c').server;
  dead.closeAllConnections();
  await new Promise((resolve) => dead.close(resolve));

  const res = await request('node-a', key);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /node-c is unreachable/);
});