// Starts several cache nodes on this machine, for development.
//   npm run cluster        -> 3 nodes on ports 3001, 3002, 3003
//   npm run cluster -- 5   -> 5 nodes on ports 3001 ... 3005
// While it runs, type a command and press Enter:
//   status         which nodes are running and which are cluster members
//   kill node-c    stop one node (like a crash)
//   start node-c   start it again (it comes back with an EMPTY memory)
//   freeze node-c  pause a node: it stays "running" but answers nothing
//                  (Mac, Linux, WSL only)
//   thaw node-c    resume a frozen node
//   join           start a NEW node (node-d, node-e, ...) and add it to the
//                  running cluster; keys move to it by themselves
//   leave node-c   remove a node from the cluster; it hands its keys over first
// Press Ctrl+C to stop everything.
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const COUNT = Number(process.argv[2]) || 3;
const BASE_PORT = 3001;

const letter = (id) => id.charCodeAt(id.length - 1) - 97; // node-c -> 2
const portOf = (id) => BASE_PORT + letter(id);
const urlOf = (id) => `http://localhost:${portOf(id)}`;
const nodeName = (index) => `node-${String.fromCharCode(97 + index)}`;

const known = Array.from({ length: COUNT }, (_, i) => nodeName(i)); // every id ever started
const members = [...known]; // ids that are currently part of the cluster
const running = new Map(); // id -> child process
const frozen = new Set(); // ids that are currently paused

function startNode(id, { alone = false } = {}) {
  if (running.has(id)) {
    console.log(`${id} is already running`);
    return;
  }
  // A brand new node only knows itself; the cluster tells it about the others.
  const list = alone ? [id] : members;
  const child = spawn(process.execPath, ['src/index.js'], {
    env: {
      ...process.env,
      NODE_ID: id,
      PORT: String(portOf(id)),
      CLUSTER: list.map((member) => `${member}=${urlOf(member)}`).join(','),
      ANTI_ENTROPY_INTERVAL_MS: process.env.ANTI_ENTROPY_INTERVAL_MS ?? '2000',
    },
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

// Ask a running member to change the cluster. It tells all the other nodes.
async function changeMembership(method, id, body) {
  const contact = members.find((member) => member !== id && running.has(member));
  if (!contact) throw new Error('no running member to talk to');
  const response = await fetch(`${urlOf(contact)}/cluster/nodes/${id}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${contact} answered ${response.status}`);
}

async function joinNode() {
  const id = nodeName(known.length);
  known.push(id);
  startNode(id, { alone: true });
  await new Promise((resolve) => setTimeout(resolve, 600)); // let it start listening
  await changeMembership('PUT', id, { url: urlOf(id) });
  members.push(id);
  console.log(`${id} joined the cluster: keys are moving to it`);
}

async function leaveNode(id) {
  if (!members.includes(id)) {
    console.log(`${id} is not a cluster member`);
    return;
  }
  await changeMembership('DELETE', id);
  members.splice(members.indexOf(id), 1);
  console.log(`${id} left the cluster: it is handing its keys to the others`);
  setTimeout(() => stopNode(id), 3000); // give it time to hand everything over
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const [command, id] = line.trim().split(/\s+/);
  try {
    if (command === 'status') {
      for (const nodeId of known) {
        const state = !running.has(nodeId) ? 'stopped' : frozen.has(nodeId) ? 'frozen' : 'running';
        console.log(`${nodeId}: ${state}${members.includes(nodeId) ? '' : ' (not a member)'}`);
      }
    } else if (command === 'join') {
      await joinNode();
    } else if (command === 'leave' && known.includes(id)) {
      await leaveNode(id);
    } else if (['kill', 'start', 'freeze', 'thaw'].includes(command) && known.includes(id)) {
      if (command === 'kill') stopNode(id);
      else if (command === 'start') startNode(id);
      else freezeNode(id, command === 'freeze');
    } else if (command) {
      console.log('commands: status | join | leave <id> | kill <id> | start <id> | freeze <id> | thaw <id>');
      console.log(`ids: ${known.join(', ')}`);
    }
  } catch (error) {
    console.log(`could not do that: ${error.message}`);
  }
});

for (const id of members) startNode(id);

function stopAll() {
  for (const id of [...running.keys()]) stopNode(id);
  process.exit(0);
}
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);