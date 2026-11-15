// Starts several cache nodes on this machine, for development.
//   npm run cluster        -> 3 nodes on ports 3001, 3002, 3003
//   npm run cluster -- 5   -> 5 nodes on ports 3001 ... 3005
// While it runs, type a command and press Enter:
//   status         which nodes are running
//   kill node-c    stop one node (like a crash)
//   start node-c   start it again (it comes back with an EMPTY memory)
// Press Ctrl+C to stop everything.
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const COUNT = Number(process.argv[2]) || 3;
const BASE_PORT = 3001;

const ids = Array.from({ length: COUNT }, (_, i) => `node-${String.fromCharCode(97 + i)}`);
const cluster = ids.map((id, i) => `${id}=http://localhost:${BASE_PORT + i}`).join(',');
const running = new Map(); // id -> child process

function startNode(id) {
  if (running.has(id)) {
    console.log(`${id} is already running`);
    return;
  }
  const port = BASE_PORT + ids.indexOf(id);
  const child = spawn(process.execPath, ['src/index.js'], {
    env: { ...process.env, NODE_ID: id, PORT: String(port), CLUSTER: cluster },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) {
    readline.createInterface({ input: stream }).on('line', (line) => {
      console.log(`[${id}] ${line}`);
    });
  }
  child.on('exit', (code) => {
    if (running.get(id) === child) running.delete(id);
    console.log(`[${id}] stopped (code ${code})`);
  });
  running.set(id, child);
}

function stopNode(id) {
  const child = running.get(id);
  if (!child) {
    console.log(`${id} is not running`);
    return;
  }
  running.delete(id);
  child.kill();
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const [command, id] = line.trim().split(/\s+/);
  if (command === 'status') {
    for (const nodeId of ids) {
      console.log(`${nodeId}: ${running.has(nodeId) ? 'running' : 'stopped'}`);
    }
  } else if ((command === 'kill' || command === 'start') && ids.includes(id)) {
    if (command === 'kill') stopNode(id);
    else startNode(id);
  } else if (command) {
    console.log(`commands: status | kill <id> | start <id>   (ids: ${ids.join(', ')})`);
  }
});

for (const id of ids) startNode(id);

function stopAll() {
  for (const child of running.values()) child.kill();
  process.exit(0);
}
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);