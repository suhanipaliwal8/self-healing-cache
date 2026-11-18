// Helps you SEE what happens to your data when the cluster changes.
//   npm run demo:data -- fill 200    write 200 keys (data-0 ... data-199)
//   npm run demo:data -- check 200   read them back and count missing or wrong ones
//   npm run demo:data -- where       how many keys each node holds right now
// Talks to node-a..node-e on ports 3001-3005 (whichever are running).
import { CacheClient } from '../src/client.js';

const BASE_PORT = 3001;
const urls = Array.from({ length: 5 }, (_, i) => `http://localhost:${BASE_PORT + i}`);
const [command = 'where', countText = '200'] = process.argv.slice(2);
const count = Number(countText);

async function alive(url) {
  try {
    return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) })).ok;
  } catch {
    return false;
  }
}
const running = [];
for (const url of urls) if (await alive(url)) running.push(url);
if (running.length === 0) {
  console.log('no node is running. Start a cluster first: npm run cluster');
  process.exit(1);
}

if (command === 'fill' || command === 'check') {
  const client = new CacheClient({ nodes: running, retries: 2 });
  let bad = 0;
  for (let i = 0; i < count; i++) {
    if (command === 'fill') {
      await client.set(`data-${i}`, `value-${i}`);
    } else {
      const got = await client.get(`data-${i}`);
      if (got?.value !== `value-${i}`) {
        bad++;
        if (bad <= 5) console.log(`missing or wrong: data-${i} -> ${JSON.stringify(got)}`);
      }
    }
  }
  console.log(command === 'fill' ? `wrote ${count} keys` : `checked ${count} keys: ${bad} missing or wrong`);
} else if (command === 'where') {
  for (const url of urls) {
    if (!(await alive(url))) continue;
    const { self: id } = await (await fetch(`${url}/cluster`)).json(); // the node's real name
    const { entries } = await (await fetch(`${url}/internal/digest`)).json();
    const live = entries.filter((entry) => !entry.deleted).length;
    console.log(`${id}: ${String(live).padStart(4)} keys  ${'#'.repeat(Math.round(live / 10))}`);
  }
} else {
  console.log('usage: npm run demo:data -- fill|check <count>   or   -- where');
}