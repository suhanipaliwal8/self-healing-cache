// Starts several cache nodes on this machine, for development.
//   npm run cluster        -> 3 nodes on ports 3001, 3002, 3003
//   npm run cluster -- 5   -> 5 nodes on ports 3001 ... 3005
// Press Ctrl+C to stop them all.
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const COUNT = Number(process.argv[2]) || 3;
const BASE_PORT = 3001;

const ids = Array.from({ length: COUNT }, (_, i) => `node-${String.fromCharCode(97 + i)}`);
const cluster = ids.map((id, i) => `${id}=http://localhost:${BASE_PORT + i}`).join(',');

const children = ids.map((id, i) => {
  const child = spawn(process.execPath, ['src/index.js'], {
    env: { ...process.env, NODE_ID: id, PORT: String(BASE_PORT + i), CLUSTER: cluster },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) {
    readline.createInterface({ input: stream }).on('line', (line) => {
      console.log(`[${id}] ${line}`);
    });
  }
  child.on('exit', (code) => console.log(`[${id}] exited (code ${code})`));
  return child;
});

function stopAll() {
  for (const child of children) child.kill();
  process.exit(0);
}
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);