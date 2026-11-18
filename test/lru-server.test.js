import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';

// One standalone node with a small memory limit.
async function startNode(t, maxEntries) {
  const server = createServer(new Store({ maxEntries }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const put = (url, key, value) =>
  fetch(`${url}/keys/${key}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });

test('stats: GET /stats shows keys, limit and evictions', async (t) => {
  const url = await startNode(t, 5);
  const res = await fetch(`${url}/stats`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { keys: 0, maxEntries: 5, evictions: 0 });
});

test('lru over HTTP: a full node evicts the oldest key', async (t) => {
  const url = await startNode(t, 3);
  for (let i = 0; i < 5; i++) assert.equal((await put(url, `k${i}`, i)).status, 200);

  assert.equal((await fetch(`${url}/keys/k0`)).status, 404);
  assert.equal((await fetch(`${url}/keys/k1`)).status, 404);
  for (const key of ['k2', 'k3', 'k4']) assert.equal((await fetch(`${url}/keys/${key}`)).status, 200);

  const stats = await (await fetch(`${url}/stats`)).json();
  assert.deepEqual(stats, { keys: 3, maxEntries: 3, evictions: 2 });
});

test('lru over HTTP: a GET refreshes the key so it survives', async (t) => {
  const url = await startNode(t, 3);
  for (let i = 0; i < 3; i++) await put(url, `k${i}`, i);

  assert.equal((await fetch(`${url}/keys/k0`)).status, 200); // k0 is now fresh
  await put(url, 'k3', 3); // evicts k1, not k0

  assert.equal((await fetch(`${url}/keys/k1`)).status, 404);
  assert.equal((await fetch(`${url}/keys/k0`)).status, 200);
});