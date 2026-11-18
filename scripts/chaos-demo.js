// The chaos demo: keep a steady load on the cluster, kill a node in the middle
// of it, and prove that no request failed and no data was lost.
//
//   npm run chaos -- --kill "docker compose stop node-c"
//   npm run chaos -- --kill "kubectl delete pod cache-1" --duration 40 --kill-at 10
//   npm run chaos                       (no --kill: kill a node yourself while it runs)
//
// Options (times are in seconds):
//   --duration 30       how long the load runs
//   --kill-at 10        when to run the kill command
//   --kill "<command>"  any shell command that breaks something
//   --settle 5          wait this long after the load, before checking the data
//   --concurrency 4     how many requests run at the same time
//   --retries 1         retries per request (try 0 to see why they matter)
//   --nodes a,b,c       node URLs (default http://localhost:3001..3003, or NODES)
// The exit code is 0 for PASS and 1 for FAIL, so CI can use it.
import { spawn } from 'node:child_process';
import { CacheClient } from '../src/client.js';
import { parseChaosArgs, runLoad, verifyKeys, summarize, formatSummary } from '../src/chaos.js';

let options;
try {
  options = parseChaosArgs(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  console.error('usage: npm run chaos -- [--duration s] [--kill-at s] [--kill "<command>"] [--settle s] [--concurrency n] [--retries n] [--nodes a,b,c]');
  process.exit(2);
}

const client = new CacheClient({ nodes: options.nodes, retries: options.retries });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const seconds = (ms) => (ms / 1000).toFixed(1);

console.log(
  `Load: ${options.concurrency} workers for ${seconds(options.durationMs)} s on ${options.nodes.length} nodes, ${options.retries} retry per request`,
);

const startedAt = Date.now();
let killedAtMs = null;

if (options.killCommand) {
  setTimeout(() => {
    killedAtMs = Date.now() - startedAt;
    console.log(`\n>>> t=${seconds(killedAtMs)} s: ${options.killCommand}\n`);
    const child = spawn(options.killCommand, { shell: true, stdio: 'inherit' });
    child.on('exit', (code) => {
      if (code !== 0) console.log(`(the kill command exited with code ${code})`);
    });
  }, options.killAtMs);
} else {
  console.log(`No --kill command given: kill a node yourself, ideally around t=${seconds(options.killAtMs)} s.`);
}

const load = await runLoad({
  client,
  durationMs: options.durationMs,
  concurrency: options.concurrency,
  onFailure: (failure) => console.log(`FAILED  t=${seconds(failure.atMs)} s  ${failure.message}`),
});
const loadStats = { ...client.stats }; // the numbers of the load phase only

console.log(`\nLoad finished. Waiting ${seconds(options.settleMs)} s, then reading back all ${load.written.size} keys...`);
await sleep(options.settleMs);
const verify = await verifyKeys({ client, written: load.written });

const summary = summarize({ load, verify, stats: loadStats, durationMs: options.durationMs, killedAtMs });
console.log(`\n${formatSummary(summary)}`);
process.exit(summary.passed ? 0 : 1);