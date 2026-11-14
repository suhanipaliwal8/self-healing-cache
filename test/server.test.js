import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';

let server;
let baseUrl;

before(async () => {
  server = createServer(new Store());
  // Port 0 means "pick any free port", so tests never clash with a running node.
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

function put(key, body) {
  return fetch(`${baseUrl}/keys/${key}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

test('server: GET /health returns ok', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('server: PUT then GET returns the stored value', async () => {
  const putRes = await put('name', JSON.stringify({ value: 'alice' }));
  assert.equal(putRes.status, 200);

  const getRes = await fetch(`${baseUrl}/keys/name`);
  assert.equal(getRes.status, 200);
  assert.deepEqual(await getRes.json(), { key: 'name', value: 'alice' });
});

test('server: GET on a missing key returns 404', async () => {
  const res = await fetch(`${baseUrl}/keys/missing`);
  assert.equal(res.status, 404);
});

test('server: DELETE removes a key', async () => {
  await put('temp', JSON.stringify({ value: 1 }));

  const first = await fetch(`${baseUrl}/keys/temp`, { method: 'DELETE' });
  assert.deepEqual(await first.json(), { deleted: true });

  const after = await fetch(`${baseUrl}/keys/temp`);
  assert.equal(after.status, 404);

  const second = await fetch(`${baseUrl}/keys/temp`, { method: 'DELETE' });
  assert.deepEqual(await second.json(), { deleted: false });
});

test('server: PUT with invalid JSON returns 400', async () => {
  const res = await put('bad', '{not json');
  assert.equal(res.status, 400);
});

test('server: PUT without a "value" field returns 400', async () => {
  const res = await put('bad', JSON.stringify({ nope: 1 }));
  assert.equal(res.status, 400);
});