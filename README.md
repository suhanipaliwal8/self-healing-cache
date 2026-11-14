# Self-Healing Distributed Cache

[![CI](https://github.com/<your-username>/self-healing-cache/actions/workflows/ci.yml/badge.svg)](https://github.com/<your-username>/self-healing-cache/actions/workflows/ci.yml)

A Redis-style distributed cache built from scratch in Node.js: sharded with
consistent hashing, replicated across nodes, and able to survive a node
failure live without failing client requests.

> **Status:** 🚧 Phase 4 complete: several nodes form a cluster and route
> each request to the node that owns the key. Replication and failover come
> in later phases, so a dead node's keys are unreachable for now.

## Why this project?

Calling `SET` and `GET` on Redis is easy. This project builds the layer
underneath: consistent hashing, replication, failure detection, failover
and rebalancing.

## Planned features

- [x] A single cache node with GET / PUT / DELETE over HTTP
- [x] TTL expiry (lazy + active) using absolute expiry timestamps
- [x] Consistent hash ring with virtual nodes
- [x] Independent cache nodes forming one logical cluster
- [ ] Replication of every key to at least one more node
- [ ] TTL honored consistently across replicas
- [ ] Automatic failure detection (heartbeat / gossip)
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
git clone https://github.com/<your-username>/self-healing-cache.git
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

Talk to **any** node. The node you ask forwards the request to the key's
owner and the `x-served-by` header tells you who answered:

```bash
curl -X PUT localhost:3001/keys/user:1 \
  -H "Content-Type: application/json" -d '{"value":"alice"}'
curl -i localhost:3002/keys/user:1      # x-served-by: node-c
curl localhost:3001/cluster             # who this node knows about
```

### Configuration (environment variables)

| Variable | Meaning | Example |
|----------|---------|---------|
| `NODE_ID` | This node's id, must appear in `CLUSTER` | `node-b` |
| `CLUSTER` | Every node as `id=url` pairs, comma separated | `node-a=http://localhost:3001,node-b=http://localhost:3002` |
| `PORT` | Optional. Defaults to the port in this node's own URL | `3002` |

Without `CLUSTER` a node runs on its own (port `PORT` or 3000).

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
`502` when the node that owns the key cannot be reached.

### Expiry (TTL)

- `ttl` is in seconds. Without it the key never expires.
- A key with a TTL is returned with an `expiresAt` field (milliseconds since
  1970). Keys without a TTL have no `expiresAt` field.
- A `PUT` without `ttl` on an existing key removes its old TTL.
- Expiry is stored as an **absolute timestamp**, not "seconds left", so
  replicas can copy the same timestamp and a key dies at the same moment
  everywhere.
- Expired keys are removed **lazily** when read and **actively** by a
  sweeper that runs every second.

## How it works

### Consistent hashing

Keys are assigned to nodes with a consistent hash ring (`src/hash-ring.js`).

- Keys and nodes are hashed onto a circle of 2^32 positions. A key belongs to
  the first node found walking clockwise from the key's position.
- Each node appears at 100 **virtual nodes**, which evens out the load.
- `getNode(key)` returns the owner; `getNodes(key, n)` returns the first `n`
  distinct nodes clockwise (primary first, then replica candidates).

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
- Any node accepts any request. If the key belongs to another node, the
  request is forwarded to the owner (2 second timeout) and the answer is
  relayed back to the client.
- A forwarded request carries the `x-cache-forwarded-by` header and is always
  handled by the node that receives it, so a request can never loop.
- Membership is a static list for now. Heartbeats arrive in Phase 6.

## Project structure

```
src/
  store.js       in-memory key-value store with TTL (wraps a Map)
  expiry.js      background sweeper that removes expired keys
  hash-ring.js   consistent hash ring with virtual nodes
  cluster.js     one node's view of the cluster and key ownership
  config.js      reads NODE_ID / CLUSTER / PORT from the environment
  server.js      HTTP layer: store access plus request forwarding
  index.js       starts a node
scripts/
  ring-demo.js     prints how keys spread and move on the ring
  dev-cluster.js   starts several nodes on this machine
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

## Roadmap

Each phase is delivered as one pull request. Phase 5 adds replication: every
key is copied to a second node.

## License

MIT