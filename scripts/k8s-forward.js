// Makes the pods reachable from your laptop (they live inside the cluster).
//   npm run k8s:forward        -> cache-0 on port 3001, cache-1 on 3002, cache-2 on 3003
//   npm run k8s:forward -- 5   -> 5 pods
// "kubectl port-forward" stops when its pod stops, so we start it again until
// the pod is back. Leave this running in its own terminal. Ctrl+C stops it.
import { spawn } from 'node:child_process';

const COUNT = Number(process.argv[2]) || 3;
const BASE_PORT = 3001;
const children = new Set();
let stopping = false;

function forward(index) {
  if (stopping) return;
  const child = spawn(
    'kubectl',
    ['port-forward', `pod/cache-${index}`, `${BASE_PORT + index}:3000`],
    { stdio: 'ignore' },
  );
  children.add(child);
  child.on('error', (error) => {
    console.log(`could not run kubectl: ${error.message}`);
    process.exit(1);
  });
  child.on('exit', () => {
    children.delete(child);
    setTimeout(() => forward(index), 1000); // the pod may be restarting: try again
  });
}

for (let i = 0; i < COUNT; i++) {
  forward(i);
  console.log(`cache-${i} -> http://localhost:${BASE_PORT + i}`);
}

function stop() {
  stopping = true;
  for (const child of children) child.kill();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);