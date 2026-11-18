# Self-Healing Distributed Cache

[![CI](https://github.com/suhanipaliwal8/self-healing-cache/actions/workflows/ci.yml/badge.svg)](https://github.com/suhanipaliwal8/self-healing-cache/actions/workflows/ci.yml)

A Redis-style distributed cache built from scratch in Node.js: sharded with
consistent hashing, replicated across nodes, and able to survive a node
failure live without failing client requests.

**Status:** Phase 12 done: LRU eviction (memory limit per node).

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
- [x] Automatic rebalancing when nodes join, leave or return
- [x] Docker image and a 3-node `docker compose` cluster
- [x] Kubernetes (StatefulSet on a local kind cluster) deployment
- [x] Live "kill a node" demo with zero failed requests (chaos test, also run in CI)
- [x] Stretch: LRU eviction
- [ ] Stretch: quorum reads/writes

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
| `start node-c` | Start it again (it comes back empty and refills from its peers) |
| `freeze node-c` | Pause a node: it looks alive but answers nothing (Mac, Linux, WSL) |
| `thaw node-c` | Resume a frozen node |
| `join` | Start a NEW node (node-d, node-e, ...) and add it to the running cluster |
| `leave node-c` | Remove a node from the cluster; it hands its keys to the others |

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

### Run with Docker

Requires Docker (Docker Desktop on Windows or Mac).

```bash
docker compose up --build     # builds the image and starts node-a, node-b, node-c
docker compose ps             # all three should be "healthy"
```

You reach the nodes from your machine on ports 3001, 3002 and 3003, so every
`curl` and `npm run demo:...` command above works unchanged. Inside Docker the
nodes find each other by service name (`http://node-a:3000`), because
`localhost` inside a container means the container itself.

```bash
docker compose stop node-c     # a clean stop: the node gets SIGTERM and exits
docker compose start node-c    # it comes back empty and refills from its peers
docker compose down            # remove the containers
```

Build and run a single node without compose:

```bash
docker build -t self-healing-cache .
docker run --rm -p 3000:3000 self-healing-cache
```

The image is small (`node:24-alpine`, no dependencies), runs as the non-root
`node` user, has a health check on `/health`, and starts `node` directly so it
receives `SIGTERM`. On `SIGTERM` or `SIGINT` the node stops its timers, stops
accepting connections, lets running requests finish (up to 5 seconds) and
exits.

### Run on Kubernetes (kind)

Requires [kind](https://kind.sigs.k8s.io) and `kubectl`. This runs three pods
(`cache-0`, `cache-1`, `cache-2`) in a local Kubernetes cluster.

```bash
kind create cluster --name cache
docker build -t self-healing-cache:dev .
kind load docker-image self-healing-cache:dev --name cache   # the cluster cannot pull a local image
kubectl apply -f k8s/
kubectl rollout status statefulset/cache
kubectl get pods -l app=cache
```

The pods live inside the cluster. To reach them from your laptop, leave this
running in its own terminal (cache-0 on port 3001, cache-1 on 3002, cache-2 on
3003), then use the same demos as before:

```bash
npm run k8s:forward
npm run demo:data -- fill 300
kubectl delete pod cache-1          # Kubernetes recreates it with the same name
npm run demo:data -- check 300      # 0 missing; the new pod refills from its peers
```

Clean up with `kubectl delete -f k8s/` and `kind delete cluster --name cache`.

How it fits together (`k8s/`):

- **StatefulSet** (`statefulset.yaml`): three pods with stable names. A pod that
  dies comes back with the same name (and an empty memory), so the hash ring
  does not change. The pod name becomes `NODE_ID`; `CLUSTER` lists the three
  members by DNS name (`cache-0.cache`, ...). Keep `replicas` and `CLUSTER` in step.
- **Headless Service** (`services.yaml`, `cache`): gives every pod its own DNS
  name, published even before the pod is Ready so nodes can find each other
  while starting. A second Service, `cache-client`, load-balances clients
  inside the cluster.
- **Probes**: readiness takes a pod out of the Service when `/health` fails;
  liveness restarts it only after 60 seconds of failures (a restart empties
  the memory).
- **Safe updates**: `minReadySeconds: 10` gives a replaced pod time to refill
  before the next one is touched, and a PodDisruptionBudget (`pdb.yaml`) allows
  only one pod to be taken away at a time for planned work.
- **Limits**: 256Mi memory per pod. A pod that fills it is restarted empty;
  eviction (a later phase) is the real fix.

### Chaos demo: kill a node under load

`npm run chaos` keeps a steady load on the cluster (4 workers writing a key and
reading it straight back), runs a command of your choice in the middle to break
something, then reads back every key it wrote. It passes only if **no request
failed** (after the client's retries), **no value was wrong**, and **no key was
lost**. The exit code is 0 for PASS and 1 for FAIL, so CI can use it.

```bash
docker compose up -d --build
npm run chaos -- --kill "docker compose stop node-c"
npm run chaos -- --kill "kubectl delete pod cache-1" --duration 40 --kill-at 10 --settle 15
npm run chaos -- --kill "docker compose stop node-c" --retries 0   # see why retries matter
```

| Option | Meaning | Default |
|--------|---------|---------|
| `--duration` | Seconds the load runs | `30` |
| `--kill-at` | Second at which the kill command runs | `10` |
| `--kill "<command>"` | Any shell command that breaks something | none (kill a node yourself) |
| `--settle` | Seconds to wait before reading every key back | `5` |
| `--concurrency` | Requests in flight at the same time | `4` |
| `--retries` | Client retries per request | `1` |
| `--nodes` | Comma separated node URLs (or the `NODES` variable) | `localhost:3001-3003` |

Example result (numbers vary):

```
  requests:            1760 (880 writes, 880 reads)
  retries used:        60
  failed requests:     0
  wrong values:        0
  keys checked after:  880, lost: 0
  latency (ms):        p50 4, p95 12, p99 2010, max 2050
  verdict: PASS (zero failed requests, zero wrong values, zero lost keys)
```

The p99 and max latency jump to about 2 seconds right after the kill. Requests
that reach the dead node wait for the 2 second forwarding timeout until the
heartbeat marks the node down (3 to 4 seconds). They still succeed; they are
just slow. Zero failed requests does not mean zero slow requests.

### See your data move

```bash
npm run demo:data -- fill 300     # write 300 keys
npm run demo:data -- where        # how many keys each node holds
npm run demo:data -- check 300    # read them all back: 0 should be missing
```

Type `join`, `kill node-c` + `start node-c`, or `leave node-b` in the cluster
terminal and run `where` and `check` again. Every key keeps both copies.

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
| `CLUSTER` | Every node as `id=url` pairs, comma separated (a new node may list only itself and be added later) | none (single node) |
| `PORT` | Port to listen on | port from this node's own URL, else 3000 |
| `REPLICATION_FACTOR` | Total copies of every key, primary included | `2` |
| `REPLICATION_MODE` | `sync` waits for replicas, `async` does not | `sync` |
| `HEARTBEAT_INTERVAL_MS` | How often every other node is pinged | `1000` |
| `HEARTBEAT_TIMEOUT_MS` | How long to wait for one ping answer | `500` |
| `FAILURE_THRESHOLD` | Failed pings in a row before a node counts as down | `3` |
| `ANTI_ENTROPY_INTERVAL_MS` | How often a node compares notes with every peer | `5000` |
| `MAX_ENTRIES` | Most live keys one node may hold. When full, the least recently used key is evicted. | `0` (no limit) |

## API

| Method | Path | Body | Success response |
|--------|------|------|------------------|
| `GET` | `/health` | none | `200 {"status":"ok"}` |
| `GET` | `/cluster` | none | `200 {"self":"node-a","nodes":[{"id","url","status"}]}` (cluster mode only) |
| `PUT` | `/cluster/nodes/:id` | `{"url": "http://host:port"}` | `200 {"ok":true,"nodes":[...]}` adds a node to the running cluster |
| `DELETE` | `/cluster/nodes/:id` | none | `200 {"ok":true,"nodes":[...]}` removes a node |
| `PUT` | `/keys/:key` | `{"value": <any JSON>, "ttl": <seconds, optional>}` | `200 {"ok":true}` |
| `GET` | `/keys/:key` | none | `200 {"key":"...","value":...}` or `404` |
| `DELETE` | `/keys/:key` | none | `200 {"deleted":true}` or `{"deleted":false}` |
| `GET` | `/stats` | none | This node's `{ keys, maxEntries, evictions }` (not forwarded) |

Errors: `400` for invalid JSON, a missing `value`, or a `ttl` that is not a
positive number; `405` for an unsupported method; `404` for unknown paths;
`502` when no node holding the key can be reached.

Response headers in cluster mode:

- `x-served-by`: the node that actually handled the request.
- `x-replicated-to`: (sync mode, writes) the replicas that confirmed their copy.
- `x-failed-over-from`: (writes) the primary that was skipped because a
  replica took over.

Nodes also expose `/internal/...` endpoints (copying keys, digests, bulk
transfer). These are used only by nodes to talk to each other, not by clients.

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

- Every node builds the same ring from the same member list, so all nodes
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
- A retry always goes to a different node than the attempt before it, even when
  many requests run at the same time.
- Retrying is safe because `GET`, `PUT` and `DELETE` are idempotent: doing
  them twice leaves the cache in the same state.
- In the live demo, with one node killed mid-run: 220 requests, 75 retries,
  0 failed requests, 0 wrong values. With retries off, 24 of 72 requests failed.

### Versions and tombstones

- Every write gets a **version**: the time of the write (made to always
  increase on one node). When two copies disagree, the **newest version wins**
  ("last write wins"). Equal versions are settled by the writer's node id, so
  every node picks the same winner.
- Copies are applied only if they are newer than what the node has, so
  copying the same record twice is harmless.
- A delete leaves a **tombstone** (a record with a version). Without it, a node
  that missed the delete would give the old value back to everyone.
  Tombstones are cleaned up after 10 minutes.

### Rebalancing and anti-entropy

One routine, `reconcile()` (`src/rebalancer.js`), keeps the copies correct. It
runs when membership changes (**rebalance**), when a node comes back or starts
(**catch-up**), and every `ANTI_ENTROPY_INTERVAL_MS` (**anti-entropy**).

- A node asks each peer for a **digest** (key + version, no values) and
  compares. It **sends** what the peer should own but lacks or has older, and
  **fetches** what it should own but lacks or has older.
- Keys that no longer belong to a node are dropped only after **every** new
  owner confirmed it holds them, so a rebalance cannot lose data.
- A read that finds the key missing on the primary also asks the replicas, so
  a node that just restarted empty does not cause false `404`s. A real miss
  costs one extra hop.

### Joining and leaving at runtime

- `PUT /cluster/nodes/:id` adds a node: the node you call tells everyone else
  and tells the new node who is already in the cluster. Everyone rebalances.
- `DELETE /cluster/nodes/:id` removes a node: it hands its keys over (if it is
  still alive) and the others restore full replication.
- In the live demo with 300 keys: after a 4th node joined, after a node
  restarted empty, and after a node left, 0 keys were missing and every key
  still had 2 copies.

### Memory limit and LRU eviction

Memory is finite (the Kubernetes pods have a 256Mi limit). With `MAX_ENTRIES=N`
a node keeps at most N live keys. When a new key does not fit, the **least
recently used** key is evicted.

- **How:** a JavaScript `Map` remembers insertion order. Using a key (GET or
  PUT) moves it to the end; the first live key is the one to evict. Everything
  is O(1), no extra data structure.
- **What counts:** live keys. Tombstones are not counted and never evicted
  (evicting one could resurrect a deleted key). Expired keys count until swept.
- **Each node decides alone.** The other copy plus read-on-miss is the backup.
- **Eviction vs anti-entropy:** background copying (rebalancer and
  `/internal/entries`) uses `evict: false`. A full node refuses *new* keys from
  it, instead of evicting someone. Otherwise the two mechanisms would undo each
  other forever ("thrashing"). Normal client writes do evict.
- **Why LRU and not LFU:** LRU needs no counters and adapts quickly.

```bash
MAX_ENTRIES=3 npm start
curl localhost:3000/stats   # { "keys": 0, "maxEntries": 3, "evictions": 0 }
```

> Run the chaos demo **without** `MAX_ENTRIES`: an evicted key counts as lost.

### Data lives in memory only

Like Redis without persistence, a node that restarts comes back **empty**.
Safety comes from the copies on other nodes, not from disk. When it returns,
its peers refill it.

## Known limitations

| Limitation | Why |
|------------|-----|
| "Newest" depends on node clocks; if clocks are far apart an older write can win | Last write wins trusts the clock. Logical clocks fix this |
| A node cut off from the network can return old values until it reconnects | The cache stays available instead of always fresh (AP). Quorum reads in Phase 13 |
| A node that was down while membership changed does not know about the change | The member change is a one-time broadcast; Kubernetes (Phase 10) gives a stable member list |
| A node down for longer than the tombstone lifetime (10 min) can bring back a deleted key | Tombstones are cleaned up |
| Digests list every key | Fine at this size; large systems use Merkle trees |
| The limit counts keys, not bytes | A few huge values can still use a lot of memory. A byte-based limit needs size accounting. |
| Full peers keep refusing repair | A full node refuses new keys from anti-entropy, so peers may re-send them every round (some wasted traffic, no data loss). |

## Project structure

```
src/
  store.js              in-memory key-value store: TTL, versions, tombstones, LRU eviction
  expiry.js             background sweeper that removes expired keys
  hash-ring.js          consistent hash ring with virtual nodes
  cluster.js            one node's view: key owners, replicas, who is up
  failure-detector.js   heartbeat pings that mark nodes up or down
  rebalancer.js         moves keys, catches nodes up, anti-entropy
  shutdown.js           clean exit on SIGTERM / SIGINT
  config.js             reads NODE_ID / CLUSTER / PORT / replication / heartbeat settings
  server.js             HTTP layer: forwarding, replication, failover, membership
  client.js             CacheClient: round robin and retries
  chaos.js              load generator, key verification and report for the chaos demo
  index.js              starts a node
scripts/
  ring-demo.js      prints how keys spread and move on the ring
  dev-cluster.js    starts several nodes locally; kill / start / freeze / thaw / join / leave
  client-demo.js    writes and reads keys while you break nodes
  data-demo.js      fill / check / where: see your data move
  k8s-forward.js    keeps kubectl port-forward running for each pod
  chaos-demo.js     kill a node under load and check for failures and lost keys
test/               tests using the built-in node:test runner
.nvmrc              Node version used for development
k8s/                StatefulSet, Services and PodDisruptionBudget
Dockerfile          builds the node image (node:24-alpine)
.dockerignore       files that stay out of the image
docker-compose.yml  a 3-node cluster in containers
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
| 8     | 26        | 131   |
| 9     | 6         | 137   |
| 10    | 3         | 140   |
| 11    | 11        | 151   |
| 12    | 16        | 167   |

## Roadmap

Each phase is delivered as one pull request. The core requirements are done.
Phase 12 adds LRU eviction and Phase 13 adds quorum reads and writes (both
stretch goals).

Next: **Phase 13**, quorum reads/writes (the last stretch goal).

## License

MIT