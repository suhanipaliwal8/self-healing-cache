import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstSuccesses, newestRecord } from '../src/quorum.js';

test('firstSuccesses: resolves as soon as enough tasks succeeded, without waiting for the slow one', async () => {
  let release;
  const slow = new Promise((resolve) => (release = resolve));

  const result = await firstSuccesses([async () => 'a', async () => 'b', () => slow], 2);

  assert.deepEqual([...result.successes].sort(), ['a', 'b']);
  assert.equal(result.failures.length, 0);
  release('c'); // let the slow task finish so nothing is left hanging
});

test('firstSuccesses: if too few succeed it resolves when everything has finished', async () => {
  const result = await firstSuccesses(
    [() => Promise.reject(new Error('node down')), async () => 'ok'],
    2,
  );

  assert.deepEqual(result.successes, ['ok']);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].message, 'node down');
});

test('firstSuccesses: no tasks, or nothing needed, resolves immediately', async () => {
  assert.deepEqual(await firstSuccesses([], 1), { successes: [], failures: [] });
  assert.deepEqual(await firstSuccesses([async () => 'x'], 0), { successes: [], failures: [] });
});

test('newestRecord: higher version wins, writer breaks ties, undefined is ignored, tombstones can win', () => {
  const old = { value: 'old', version: 100, writer: 'node-a' };
  const fresh = { value: 'new', version: 200, writer: 'node-a' };
  assert.equal(newestRecord([old, fresh, undefined]), fresh);
  assert.equal(newestRecord([fresh, old]), fresh);

  const tieA = { value: 'a', version: 300, writer: 'node-a' };
  const tieB = { value: 'b', version: 300, writer: 'node-b' };
  assert.equal(newestRecord([tieA, tieB]), tieB);

  const tombstone = { deleted: true, version: 400, writer: 'node-a' };
  assert.equal(newestRecord([fresh, tombstone]), tombstone);

  assert.equal(newestRecord([]), undefined);
  assert.equal(newestRecord([undefined, undefined]), undefined);
});