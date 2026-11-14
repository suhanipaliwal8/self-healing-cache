import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';

let server;
let baseUrl;
let time = 1_000_000; // fake clock, so we can jump forward in time

before(async () => {
  server = createServer(new Store({ now: () => time }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

function put(key, payload) {
  return fetch(`${baseUrl}/keys/${key}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

test('server ttl: key with ttl shows expiresAt, then returns 404 after it expires', async () => {
  await put('session', { value: 'abc', ttl: 10 });

  const before = await fetch(`${baseUrl}/keys/session`);
  assert.equal(before.status, 200);
  assert.deepEqual(await before.json(), {
    key: 'session',
    value: 'abc',
    expiresAt: time + 10_000,
  });

  time += 10_000;
  const afterExpiry = await fetch(`${baseUrl}/keys/session`);
  assert.equal(afterExpiry.status, 404);
});

test('server ttl: invalid ttl values return 400', async () => {
  for (const ttl of [0, -5, 'ten', null]) {
    const res = await put('bad', { value: 1, ttl });
    assert.equal(res.status, 400, `ttl=${JSON.stringify(ttl)} should be rejected`);
  }
});

test('server ttl: PUT without ttl makes the key permanent again', async () => {
  await put('perm', { value: 1, ttl: 5 });
  await put('perm', { value: 2 });
  time += 60_000;
  const res = await fetch(`${baseUrl}/keys/perm`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { key: 'perm', value: 2 });
});