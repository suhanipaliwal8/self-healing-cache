// Starts several cache nodes on this machine, for development.
//   npm run cluster        -> 3 nodes on ports 3001, 3002, 3003
//   npm run cluster -- 5   -> 5 nodes on ports 3001 ... 3005
// While it runs, type a command and press Enter:
//   status         which nodes are running
//   kill node-c    stop one node (like a crash)
//   start node-c   start it again (it comes back with an EMPTY memory)
//   freeze node-c  pause a node: it stays "running" but answers nothing
//                  (Mac, Linux, WSL only)
//   thaw node-c    resume a frozen node
// Press Ctrl+C to stop everything.
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const COUNT = Number(process.argv[2]) || 3;
const BASE_PORT = 3001;

const ids = Array.from({ length: COUNT }, (_, i) => `node-${String.fromCharCode(97 + i)}`);
const cluster = ids.map((id, i) => `${id}=http://localhost:${BASE_PORT + i}`).join(',');
const running = new Map(); // id -> child process
const frozen = new Set(); // ids that are currently paused

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
  if (frozen.delete(id)) child.kill('SIGCONT'); // a paused process must wake up to exit
  child.kill();
}

function freezeNode(id, freeze) {
  const child = running.get(id);
  if (!child) {
    console.log(`${id} is not running`);
    return;
  }
  try {
    child.kill(freeze ? 'SIGSTOP' : 'SIGCONT');
    if (freeze) frozen.add(id);
    else frozen.delete(id);
    console.log(`${id} is ${freeze ? 'frozen' : 'running again'}`);
  } catch {
    console.log('freeze and thaw need Mac, Linux or WSL (Windows cannot pause a process)');
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const [command, id] = line.trim().split(/\s+/);
  if (command === 'status') {
    for (const nodeId of ids) {
      const state = !running.has(nodeId) ? 'stopped' : frozen.has(nodeId) ? 'frozen' : 'running';
      console.log(`${nodeId}: ${state}`);
    }
  } else if (['kill', 'start', 'freeze', 'thaw'].includes(command) && ids.includes(id)) {
    if (command === 'kill') stopNode(id);
    else if (command === 'start') startNode(id);
    else freezeNode(id, command === 'freeze');
  } else if (command) {
    console.log(`commands: status | kill <id> | start <id> | freeze <id> | thaw <id>`);
    console.log(`ids: ${ids.join(', ')}`);
  }
});

for (const id of ids) startNode(id);

function stopAll() {
  for (const id of [...running.keys()]) stopNode(id);
  process.exit(0);
}
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);