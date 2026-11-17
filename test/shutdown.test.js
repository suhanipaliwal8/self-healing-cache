import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { installShutdown } from '../src/shutdown.js';

// A fake server that records what we did to it.
function fakeServer({ finishesClosing = true } = {}) {
  const calls = [];
  return {
    calls,
    close(callback) {
      calls.push('close');
      if (finishesClosing) setImmediate(callback);
    },
    closeIdleConnections: () => calls.push('closeIdleConnections'),
    closeAllConnections: () => calls.push('closeAllConnections'),
  };
}

test('shutdown: SIGTERM stops the timers, closes the server and exits with 0', async () => {
  const proc = new EventEmitter();
  const server = fakeServer();
  const events = [];
  installShutdown({
    server,
    stop: [() => events.push('stopped timer')],
    proc,
    exit: (code) => events.push(`exit ${code}`),
    log: () => {},
  });

  proc.emit('SIGTERM');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, ['stopped timer', 'exit 0']);
  assert.deepEqual(server.calls, ['close', 'closeIdleConnections']);
});

test('shutdown: SIGINT works too, and a second signal does nothing', async () => {
  const proc = new EventEmitter();
  const server = fakeServer();
  const codes = [];
  installShutdown({ server, proc, exit: (code) => codes.push(code), log: () => {} });

  proc.emit('SIGINT');
  proc.emit('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(server.calls.filter((call) => call === 'close').length, 1);
  assert.deepEqual(codes, [0]);
});

test('shutdown: if requests never finish, connections are closed and we exit with 1', async () => {
  const proc = new EventEmitter();
  const server = fakeServer({ finishesClosing: false });
  const codes = [];
  installShutdown({ server, proc, graceMs: 30, exit: (code) => codes.push(code), log: () => {} });

  proc.emit('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.ok(server.calls.includes('closeAllConnections'));
  assert.deepEqual(codes, [1]);
});

test(
  'shutdown: a real node exits by itself with code 0 when it gets SIGTERM',
  { skip: process.platform === 'win32' && 'Windows cannot send SIGTERM to a process' },
  async () => {
    // find a free port
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));

    const child = spawn(process.execPath, ['src/index.js'], {
      env: { ...process.env, PORT: String(port), CLUSTER: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.on('exit', () => {});

    // wait until it listens
    const start = Date.now();
    while (!output.includes('listening')) {
      if (Date.now() - start > 5000) throw new Error('node did not start');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    child.kill('SIGTERM');

    const result = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 3000)),
    ]);
    if (result === 'timeout') child.kill('SIGKILL');
    assert.deepEqual(result, { code: 0, signal: null });
  },
);