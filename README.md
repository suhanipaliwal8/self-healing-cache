# Self-Healing Distributed Cache

A Redis-style distributed cache built from scratch in Node.js: sharded with
consistent hashing, replicated across nodes, and able to survive a node
failure live without failing client requests.

> **Status:** 🚧 Phase 2 complete: a single node with TTL expiry.
> Clustering, replication and failover come in later phases.

## Why this project?

Calling `SET` and `GET` on Redis is easy. This project builds the layer
underneath: consistent hashing, replication, failure detection, failover
and rebalancing.

## Planned features

- [x] A single cache node with GET / PUT / DELETE over HTTP
- [x] TTL expiry (lazy + active) using absolute expiry timestamps
- [ ] Consistent hashing with virtual nodes
- [ ] Independent cache nodes forming one logical cluster
- [ ] Replication of every key to at least one more node
- [ ] TTL honored consistently across replicas
- [ ] Automatic failure detection (heartbeat / gossip)
- [ ] Automatic rebalancing when nodes join or return
- [ ] Live "kill a node" demo with zero failed requests
- [ ] Stretch: LRU eviction, quorum reads/writes

## Tech stack

Node.js 24 · node:http · node:test · Docker · Kubernetes · GitHub Actions

## Getting started

Requires Node.js 24 (developed on v24.11.0, see `.nvmrc`). No dependencies
to install.

```bash
git clone <your-repo-url>
cd self-healing-cache
npm start            # starts a node on port 3000
```

Use another port with the `PORT` environment variable:

```bash
PORT=3001 npm start
```

## API

| Method | Path | Body | Success response |
|--------|------|------|------------------|
| `GET` | `/health` | none | `200 {"status":"ok"}` |
| `PUT` | `/keys/:key` | `{"value": <any JSON>, "ttl": <seconds, optional>}` | `200 {"ok":true}` |
| `GET` | `/keys/:key` | none | `200 {"key":"...","value":...}` or `404` |
| `DELETE` | `/keys/:key` | none | `200 {"deleted":true}` or `{"deleted":false}` |

Errors: `400` for invalid JSON, a missing `value`, or a `ttl` that is not a
positive number; `405` for an unsupported method; `404` for unknown paths.

### Expiry (TTL)

- `ttl` is in seconds. Without it the key never expires.
- A key with a TTL is returned with an `expiresAt` field (milliseconds since
  1970). Keys without a TTL have no `expiresAt` field.
- A `PUT` without `ttl` on an existing key removes its old TTL.
- Expiry is stored as an **absolute timestamp**, not "seconds left". When
  replication arrives, every replica will copy the same timestamp so a key
  dies at the same moment everywhere.
- Expired keys are removed in two ways: **lazily** when someone reads them,
  and **actively** by a sweeper that runs every second.

### Try it

```bash
curl -X PUT localhost:3000/keys/session \
  -H "Content-Type: application/json" -d '{"value":"abc","ttl":10}'
curl localhost:3000/keys/session
curl -X DELETE localhost:3000/keys/session
```

## Project structure

```
src/
  store.js     in-memory key-value store with TTL (wraps a Map)
  expiry.js    background sweeper that removes expired keys
  server.js    HTTP layer on top of the store
  index.js     starts a node
test/          tests using the built-in node:test runner
.nvmrc         Node version used for development
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

## Roadmap

Each phase is delivered as one pull request. Phase 3 adds the consistent
hash ring.

## License

MIT