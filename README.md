# Self-Healing Distributed Cache

A Redis-style distributed cache built from scratch in Node.js: sharded with
consistent hashing, replicated across nodes, and able to survive a node
failure live without failing client requests.

> **Status:** 🚧 Phase 1 complete: a single cache node works over HTTP.
> Clustering, replication and failover come in later phases.

## Why this project?

Calling `SET` and `GET` on Redis is easy. This project builds the layer
underneath: consistent hashing, replication, failure detection, failover
and rebalancing.

## Planned features

- [x] A single cache node with GET / PUT / DELETE over HTTP
- [ ] TTL expiry honored consistently across replicas
- [ ] Consistent hashing with virtual nodes
- [ ] Independent cache nodes forming one logical cluster
- [ ] Replication of every key to at least one more node
- [ ] Automatic failure detection (heartbeat / gossip)
- [ ] Automatic rebalancing when nodes join or return
- [ ] Live "kill a node" demo with zero failed requests
- [ ] Stretch: LRU eviction, quorum reads/writes

## Tech stack

Node.js 24 · node:http · node:test · Docker · Kubernetes · GitHub Actions

## Getting started

Requires Node.js 24 or newer. No dependencies to install.

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
| `PUT` | `/keys/:key` | `{"value": <any JSON>}` | `200 {"ok":true}` |
| `GET` | `/keys/:key` | none | `200 {"key":"...","value":...}` or `404` |
| `DELETE` | `/keys/:key` | none | `200 {"deleted":true}` or `{"deleted":false}` |

Errors: `400` for invalid JSON or a missing `value` field, `405` for an
unsupported method, `404` for unknown paths.

### Try it

```bash
curl -X PUT localhost:3000/keys/name \
  -H "Content-Type: application/json" -d '{"value":"alice"}'
curl localhost:3000/keys/name
curl -X DELETE localhost:3000/keys/name
```

## Project structure

```
src/
  store.js     in-memory key-value store (wraps a Map)
  server.js    HTTP layer on top of the store
  index.js     starts a node
test/          tests using the built-in node:test runner
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

## Roadmap

Each phase is delivered as one pull request. Phase 2 adds TTL expiry.

## License

MIT