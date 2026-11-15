# Self-Healing Distributed Cache

[![CI](https://github.com/suhanipaliwal8/self-healing-cache/actions/workflows/ci.yml/badge.svg)](https://github.com/<your-username>/self-healing-cache/actions/workflows/ci.yml)

A Redis-style distributed cache built from scratch in Node.js: sharded with
consistent hashing, replicated across nodes, and able to survive a node
failure live without failing client requests.

> **Status:** 🚧 Phase 5 complete: every key is stored on a primary and a
> replica, and reads survive a dead primary. Failure detection, write
> failover and rebalancing come in later phases.

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
- [ ] Automatic failure detection (heartbeat / gossip)
- [ ] Automatic failover for writes, with client retry
- [ ] Automatic rebalancing when nodes join or return
- [ ] Live "kill a node" demo with zero failed requests
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
| `status` | Show which nodes are running |
| `kill node-c` | Stop a node, like a crash |
| `start node-c` | Start it again (it comes back with an empty memory) |

Talk to **any** node. The node you ask forwards the request to the right
node, and response headers tell you what happened:

```bash
curl -i -X PUT localhost:3001/keys/user:1 \
  -H "Content-Type: application/json" -d '{"value":"alice","ttl":120}'
# x-served-by: node-c        <- the primary stored it
# x-replicated-to: node-b    <- the replica confirmed its copy

curl -i localhost:3002/keys/user:1     # works from any node
```

Now type `kill node-c` in the cluster terminal and read again. The read is
served by the replica (`x-served-by: node-b`).

### Configuration (environment variables)

| Variable | Meaning | Default |
|----------|---------|---------|
| `NODE_ID` | This node's id, must appear in `CLUSTER` | `node-1` (single node) |
| `CLUSTER` | Every node as `id=url` pairs, comma separated | none (single node) |
| `PORT` | Port to listen on | port from this node's own URL, else 3000 |
| `REPLICATION_FACTOR` | Total copies of every key, primary included | `2` |
| `REPLICATION_MODE` | `sync` waits for replicas, `async` does not | `sync` |

## API

| Method | Path | Body | Success response |
|--------|------|------|------------------|
| `GET` | `/health` | none | `200 {"status":"ok"}` |
| `GET` | `/cluster` | none | `200 {"self":"node-a","nodes":[...]}` (cluster mode only) |
| `PUT` | `/keys/:key` | `{"value": <any JSON>, "ttl": <seconds, optional>}` | `200 {"ok":true}` |
| `GET` | `/keys/:key` | none | `200 {"key":"...","value":...}` or `404` |
| `DELETE` | `/keys/:key` | none | `200 {"deleted":true}` or `{"deleted":false}` |

Errors: `400` for invalid JSON, a missing `value`, or a `ttl` that is not a
positive number; `405` for an unsupported method; `404` for unknown paths;
`502` when no node holding the key can be reached (or, for a write, when the
primary cannot be reached).

Response headers in cluster mode:

- `x-served-by`: the node that actually handled the request.
- `x-replicated-to`: (sync mode, writes) the replicas that confirmed their copy.

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
- Membership is a static list for now. Heartbeats arrive in Phase 6.

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
- Reads try the primary first and fall back to the replicas, so a dead
  primary does not make its keys unreadable.

### Data lives in memory only

Like Redis without persistence, a node that restarts comes back **empty**.
Safety comes from the copies on other nodes, not from disk.

## Known limitations (fixed in later phases)

| Limitation | Fixed in |
|------------|----------|
| A write to a key whose primary is down returns `502` | Phase 7 |
| A node that comes back is empty and answers `404` for keys it should own | Phase 8 |
| Dead nodes are not detected, so each request waits for a timeout | Phase 6 |

## Project structure

```
src/
  store.js       in-memory key-value store with TTL (wraps a Map)
  expiry.js      background sweeper that removes expired keys
  hash-ring.js   consistent hash ring with virtual nodes
  cluster.js     one node's view of the cluster, key owners and replicas
  config.js      reads NODE_ID / CLUSTER / PORT / replication settings
  server.js      HTTP layer: forwarding, replication, read fallback
  index.js       starts a node
scripts/
  ring-demo.js     prints how keys spread and move on the ring
  dev-cluster.js   starts several nodes locally; kill / start / status
test/            tests using the built-in node:test runner
.nvmrc           Node version used for development
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

## Roadmap

Each phase is delivered as one pull request. Phase 6 adds heartbeat-based
failure detection so nodes notice a dead peer on their own.

## License

MIT