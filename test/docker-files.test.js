import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('docker: the Dockerfile uses Node 24, a non-root user, a healthcheck and starts node directly', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /^FROM node:24/m);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^HEALTHCHECK /m);
  assert.match(dockerfile, /^CMD \["node", "src\/index\.js"\]$/m); // not "npm start": npm hides SIGTERM
});

test('docker: .dockerignore keeps junk out and compose defines three nodes with their own id', () => {
  const ignore = read('.dockerignore').split(/\r?\n/).map(line => line.trim());
  for (const entry of ['.git', 'node_modules', 'test']) assert.ok(ignore.includes(entry), entry);

  const compose = read('docker-compose.yml');
  for (const id of ['node-a', 'node-b', 'node-c']) {
    assert.match(compose, new RegExp(`^  ${id}:$`, 'm'));
    assert.match(compose, new RegExp(`NODE_ID: ${id}$`, 'm'));
    assert.match(compose, new RegExp(`${id}=http://${id}:3000`)); // every node is in CLUSTER
  }
});