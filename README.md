# Self-Healing Distributed Cache

A Redis-style distributed cache built from scratch in Node.js: sharded with
consistent hashing, replicated across nodes, and able to survive a node
failure live without failing client requests.

> **Status:** 🚧 Phase 0 - project setup. Nothing runnable yet.

## Why this project?

Calling `SET` and `GET` on Redis is easy. This project builds the layer
underneath: consistent hashing, replication, failure detection, failover
and rebalancing.

## Planned features

- [ ] Independent cache nodes forming one logical cluster
- [ ] Consistent hashing with virtual nodes
- [ ] Replication of every key to at least one more node
- [ ] Automatic failure detection (heartbeat / gossip)
- [ ] Automatic rebalancing when nodes join or return
- [ ] TTL expiry honored consistently across replicas
- [ ] Live "kill a node" demo with zero failed requests
- [ ] Stretch: LRU eviction, quorum reads/writes

## Tech stack

Node.js 24 · node:http · node:test · Docker · Kubernetes · GitHub Actions

## Getting started

```bash
git clone <your-repo-url>
cd self-healing-cache
npm test
```

Requires Node.js 24 or newer.

## Project roadmap

See the phase table in the project plan. Each phase is delivered as one
pull request.

## Tests

| Phase | Tests |
|-------|-------|
| 0     | 1     |

## License

MIT