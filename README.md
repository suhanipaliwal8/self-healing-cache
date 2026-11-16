# Self-Healing Distributed Cache

[![CI](https://github.com/suhanipaliwal8/self-healing-cache/actions/workflows/ci.yml/badge.svg)](https://github.com/suhanipaliwal8/self-healing-cache/actions/workflows/ci.yml)

A Redis-style distributed cache built from scratch in Node.js: sharded with
consistent hashing, replicated across nodes, and able to survive a node
failure live without failing client requests.

> **Status:** 🚧 Phase 7 complete: writes fail over to a replica when the
> primary is down, and a client with a retry policy survives a node dying
> mid-traffic. Rebalancing when nodes return or join comes next.

## Why this project?

Calling `SET` and `GET` on Redis is easy. This project builds the layer
underneath: consistent hashing, replication, failure detection, failover
and rebalancing.

## Planned features

- [x] A single cache node with GET / PUT / DELETE over HTTP
- [x] TTL expiry (lazy + active) using absolute expiry timestamps
- [x] Consistent hash ring with virtual nodes
- [x] Independent cache nodes forming one logical cluster
- [x] Replication of every key to at least one more node
- [x] TTL honored consistently across replicas
- [x] Automatic failure detection (heartbeat)
- [x] Automatic failover for writes, with client retry
- [ ] Automatic rebalancing when nodes join or return
- [ ] Live "kill a node" demo with zero failed requests (full chaos test)
- [ ] Stretch: LRU eviction, quorum reads/writes

## Tech stack

Node.js 24 · node:http · node:crypto · node:test · Docker · Kubernetes ·
GitHub Actions

## Getting started

Requires Node.js 24 (developed on v24.11.0, see `.nvmrc`). No dependencies
to install.

```bash
git clone https://github.com/suhanipaliwal8/self-healing-cache.git
cd self-healing-cache
```

### Run a single node

```bash
npm start            # port 3000
PORT=3001 npm start  # another port
```

### Run a 3-node cluster

```bash
npm run cluster          # node-a:3001, node-b:3002, node-c:3003
npm run cluster -- 5     # 5 nodes instead of 3
```

While the cluster runs, type a command in the same terminal:

| Command | Effect |
|---------|--------|
| `status` | Show which nodes are running, frozen or stopped |
| `kill node-c` | Stop a node, like a crash |
| `start node-c` | Start it again (it comes back with an empty memory) |
| `freeze node-c` | Pause a node: it looks alive but answers nothing (Mac, Linux, WSL) |
| `thaw node-c` | Resume a frozen node |

Talk to **any** node. The node you ask forwards the request to the right
node, and response headers tell you what happened:

```bash
curl -i -X PUT localhost:3001/keys/user:1 \
  -H "Content-Type: application/json" -d '{"value":"alice","ttl":120}'
# x-served-by: node-c        <- the primary stored it
# x-replicated-to: node-b    <- the replica confirmed its copy

curl -i localhost:3002/keys/user:1     # works from any node
curl localhost:3001/cluster            # which nodes are up or down
```

Now type `kill node-c` and write again. The replica takes over:

```
x-served-by: node-b
x-failed-over-from: node-c
```

### Use the client in code

`CacheClient` spreads requests over all nodes and retries on the next node
when one does not answer.

```js
import { CacheClient } from './src/client.js';

const client = new CacheClient({
  nodes: ['http://localhost:3001', 'http://localhost:3002', 'http://localhost:3003'],
  retries: 1, // extra attempts after the first one (default 1)
});

await client.set('user:1', { name: 'alice' }, { ttl: 60 });
const hit = await client.get('user:1'); // { value, expiresAt } or undefined
await client.delete('user:1'); // true if the key existed
console.log(client.stats); // { requests, retries, failures }
```

Try it while breaking things. Start a cluster, run the demo, and type
`kill node-c` in the cluster terminal:

```bash
npm run demo:client -- 20
RETRIES=0 npm run demo:client -- 10   # no retries: some requests fail
```

### Configuration (environment variables)

| Variable | Meaning | Default |
|----------|---------|---------|
| `NODE_ID` | This node's id, must appear in `CLUSTER` | `node-1` (single node) |
| `CLUSTER` | Every node as `id=url` pairs, comma separated | none (single node) |
| `PORT` | Port to listen on | port from this node's own URL, else 3000 |
| `REPLICATION_FACTOR` | Total copies of every key, primary included | `2` |
| `REPLICATION_MODE` | `sync` waits for replicas, `async` does not | `sync` |
| `HEARTBEAT_INTERVAL_MS` | How often every other node is pinged | `1000` |
| `HEARTBEAT_TIMEOUT_MS` | How long to wait for one ping answer | `500` |
| `FAILURE_THRESHOLD` | Failed pings in a row before a node counts as down | `3` |

## API

| Method | Path | Body | Success response |
|--------|------|------|------------------|
| `GET` | `/health` | none | `200 {"status":"ok"}` |
| `GET` | `/cluster` | none | `200 {"self":"node-a","nodes":[{"id","url","status"}]}` (cluster mode only) |
| `PUT` | `/keys/:key` | `{"value": <any JSON>, "ttl": <seconds, optional>}` | `200 {"ok":true}` |
| `GET` | `/keys/:key` | none | `200 {"key":"...","value":...}` or `404` |
| `DELETE` | `/keys/:key` | none | `200 {"deleted":true}` or `{"deleted":false}` |

Errors: `400` for invalid JSON, a missing `value`, or a `ttl` that is not a
positive number; `405` for an unsupported method; `404` for unknown paths;
`502` when no node holding the key can be reached.

Response headers in cluster mode:

- `x-served-by`: the node that actually handled the request.
- `x-replicated-to`: (sync mode, writes) the replicas that confirmed their copy.
- `x-failed-over-from`: (writes) the primary that was skipped because a
  replica took over.

Nodes also expose `PUT` / `DELETE` on `/internal/keys/:key`. These are used
only by nodes to copy data to each other, not by clients.

### Expiry (TTL)

- `ttl` is in seconds. Without it the key never expires.
- A key with a TTL is returned with an `expiresAt` field (milliseconds since
  1970). Keys without a TTL have no `expiresAt` field.
- A `PUT` without `ttl` on an existing key removes its old TTL.
- Expiry is stored as an **absolute timestamp**, not "seconds left". The
  primary sends that same timestamp to the replicas, so a key dies at the
  same moment on every copy.
- Expired keys are removed **lazily** when read and **actively** by a
  sweeper that runs every second.

## How it works

### Consistent hashing

Keys are assigned to nodes with a consistent hash ring (`src/hash-ring.js`).

- Keys and nodes are hashed onto a circle of 2^32 positions. A key belongs to
  the first node found walking clockwise from the key's position.
- Each node appears at 100 **virtual nodes**, which evens out the load.
- `getNode(key)` returns the owner; `getNodes(key, n)` returns the first `n`
  distinct nodes clockwise (primary first, then replicas).

Why not `hash(key) % N`? Run the demo and compare:

```bash
npm run demo:ring
```

```
Add node-d (consistent hashing):   26.0% of keys moved, all to the new node
Going from 3 to 4 nodes with % N:  75.8% of keys moved
```

### Request routing

- Every node builds the same ring from the same `CLUSTER` list, so all nodes
  agree on who owns a key.
- Any node accepts any request and forwards it to the right node (2 second
  timeout). A forwarded request carries `x-cache-forwarded-by` and is always
  handled by the node that receives it, so a request can never loop.

### Replication

- Each key lives on `REPLICATION_FACTOR` nodes: the first is the **primary**,
  the others are **replicas** (the next distinct nodes on the ring).
- Writes go to the primary, which stores the key and copies it to the
  replicas.
- **Sync** (default): the primary waits for the replicas, then answers.
  **Async**: the primary answers first and copies in the background. Faster,
  but the latest write can be lost if the primary crashes right away.
- A write still succeeds if a replica is down. The cluster prefers staying
  available over insisting on every copy (the "AP" side of the CAP theorem).
- Reads try the primary first and fall back to the replicas.

### Failure detection

- Every node pings every other node's `/health` once per interval. A node is
  marked **down** after `FAILURE_THRESHOLD` failed pings in a row (about 3 to
  4 seconds with the defaults) and **up** again after one successful ping.
- A crashed node refuses connections at once, but a frozen or unreachable
  node makes requests wait for the full timeout. The detector removes that
  wait: in the demo a read with a frozen primary took 2.0 s before detection
  and 0.003 s after.
- A down node **stays on the hash ring**, so key owners never change when a
  node hiccups. We only stop waiting for it.
- Nodes believed to be down are tried **last**, not never, so a wrong
  suspicion cannot cause an outage.
- Each node keeps its own opinion about who is up. There is no central
  monitor that could fail.

### Write failover

- Writes go to the key's owners in order: the primary first, nodes believed
  down last. If the primary cannot be reached, the next owner **takes over as
  acting primary**: it stores the write and copies it to the other owners.
  The response says so with `x-failed-over-from`.
- When a request has to wait on several nodes in a row, timeouts can collide.
  The coordinator therefore tells the node taking over which nodes it could
  not reach (`x-cache-unreachable`), so that node does not wait for them again.
- With replication factor 1 there is nothing to fail over to, so the write
  returns `502`.

### Client retries

- `CacheClient` rotates over all nodes (round robin). If a node does not
  answer, times out, or returns `502`, `503` or `504`, the client retries on
  the **next node** (default: 1 retry, 5 second timeout).
- `404` and `400` are real answers and are never retried.
- Retrying is safe because `GET`, `PUT` and `DELETE` are idempotent: doing
  them twice leaves the cache in the same state.
- In the live demo, with one node killed mid-run: 220 requests, 75 retries,
  0 failed requests, 0 wrong values. With retries off, 24 of 72 requests failed.

### Data lives in memory only

Like Redis without persistence, a node that restarts comes back **empty**.
Safety comes from the copies on other nodes, not from disk.

## Known limitations (fixed in later phases)

| Limitation | Fixed in |
|------------|----------|
| A node that comes back is empty and answers `404` for keys it should own | Phase 8 |
| After a failover the primary and the replica can hold different values, and a node cut off from the network can come back with old values | Phase 8 |
| Keys are not moved when a node joins the cluster (membership is a fixed list) | Phase 8 |

## Project structure

```
src/
  store.js              in-memory key-value store with TTL (wraps a Map)
  expiry.js             background sweeper that removes expired keys
  hash-ring.js          consistent hash ring with virtual nodes
  cluster.js            one node's view: key owners, replicas, who is up
  failure-detector.js   heartbeat pings that mark nodes up or down
  config.js             reads NODE_ID / CLUSTER / PORT / replication / heartbeat settings
  server.js             HTTP layer: forwarding, replication, failover
  client.js             CacheClient: round robin and retries
  index.js              starts a node
scripts/
  ring-demo.js      prints how keys spread and move on the ring
  dev-cluster.js    starts several nodes locally; kill / start / freeze / thaw
  client-demo.js    writes and reads keys while you break nodes
test/               tests using the built-in node:test runner
.nvmrc              Node version used for development
```

## Running tests

```bash
npm test
```

## Tests

| Phase | New tests | Total |
|-------|-----------|-------|
| 0     | 1         | 1     |
| 1     | 11        | 12    |
| 2     | 12        | 24    |
| 3     | 11        | 35    |
| 4     | 18        | 53    |
| 5     | 17        | 70    |
| 6     | 20        | 90    |
| 7     | 16 (1 replaced) | 105 |

## Roadmap

Each phase is delivered as one pull request. Phase 8 adds rebalancing:
a node that returns, or a new node that joins, gets its keys automatically.

## License

MIT