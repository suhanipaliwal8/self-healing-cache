import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { startSweeper } from '../src/expiry.js';

test('sweeper: removes expired keys on every tick', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let time = 0;
  const store = new Store({ now: () => time });
  store.set('a', 1, { ttlMs: 500 });

  const stop = startSweeper(store, 1000);
  time = 600; // the key is now expired, but nobody has read it
  assert.equal(store.size, 1);
  t.mock.timers.tick(1000); // the sweeper wakes up
  assert.equal(store.size, 0);
  stop();
});

test('sweeper: stop() cancels further sweeps', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let time = 0;
  const store = new Store({ now: () => time });
  const stop = startSweeper(store, 1000);
  stop();

  store.set('a', 1, { ttlMs: 500 });
  time = 600;
  t.mock.timers.tick(5000);
  assert.equal(store.size, 1); // still there: the sweeper was stopped
});