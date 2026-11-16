// Writes and reads keys against a running cluster while you break nodes.
//   npm run demo:client          -> runs for 20 seconds
//   npm run demo:client -- 40    -> runs for 40 seconds
// Start a cluster first (npm run cluster) and type "kill node-c" in its
// terminal while this runs. Try RETRIES=0 to see why retries matter.
import { CacheClient } from '../src/client.js';

const nodes = (process.env.NODES ?? 'http://localhost:3001,http://localhost:3002,http://localhost:3003')
  .split(',');
const retries = process.env.RETRIES === undefined ? 1 : Number(process.env.RETRIES);
const seconds = Number(process.argv[2]) || 20;

const client = new CacheClient({ nodes, retries });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log(`Using ${nodes.length} nodes, ${retries} retry per request, for ${seconds} seconds`);

let written = 0;
let wrong = 0;
const endTime = Date.now() + seconds * 1000;

for (let i = 0; Date.now() < endTime; i++) {
  const key = `demo-${i}`;
  const retriesBefore = client.stats.retries;
  try {
    await client.set(key, `value-${i}`, { ttl: 300 });
    const got = await client.get(key);
    if (got?.value !== `value-${i}`) {
      wrong++;
      console.log(`WRONG   ${key}: got ${JSON.stringify(got)}`);
    } else {
      written++;
    }
    if (client.stats.retries > retriesBefore) console.log(`retried ${key}`);
  } catch (error) {
    console.log(`FAILED  ${error.message}`);
  }
  await sleep(100);
}

console.log('');
console.log(`keys written and read back correctly: ${written}`);
console.log(`requests: ${client.stats.requests}, retries: ${client.stats.retries}`);
console.log(`failed requests: ${client.stats.failures}, wrong values: ${wrong}`);