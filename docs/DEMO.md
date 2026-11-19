# Demo guide

Seven short demos, from simple to impressive. Everything runs on your laptop.
Windows PowerShell: use `curl.exe` instead of `curl`. Git Bash works as written.

Before you start: `npm test` should print **183 passing tests**.

## 1. The hash ring (30 seconds)

```bash
npm run demo:ring
```

Shows how evenly 10,000 keys spread over 3 nodes, and that adding a 4th node moves only about
a quarter of the keys (not all of them). That is why consistent hashing is used.

## 2. One node

```bash
npm start
curl -X PUT localhost:3000/keys/hello -H "Content-Type: application/json" -d '{"value":"world","ttl":5}'
curl localhost:3000/keys/hello        # {"key":"hello","value":"world",...}
# wait 6 seconds
curl localhost:3000/keys/hello        # 404, the key expired
```

## 3. A cluster that heals itself

Terminal 1:

```bash
npm run cluster
```

Terminal 2:

```bash
npm run demo:data -- fill 200       # write 200 keys
npm run demo:data -- where          # keys per node (each key is on 2 nodes)
```

Terminal 1, type: `kill node-c`

```bash
npm run demo:data -- check 200      # 0 missing: the other copy answered
```

Terminal 1, type: `start node-c` (it returns with an EMPTY memory), wait a few seconds:

```bash
npm run demo:data -- where          # node-c has its keys again: the peers refilled it
```

More commands in terminal 1: `status`, `join` (add node-d, keys move to it), `leave node-d`.

## 4. The chaos demo on Docker (the main demo)

```bash
docker compose up -d --build
npm run chaos -- --kill "docker compose stop node-c" --duration 30 --kill-at 10 --retries 2
docker compose down
```

What you see: four workers write a key and read it back, again and again. At t = 10 s node-c is
stopped. After the load, every key is read back and compared.

Expected: `failed requests: 0`, `wrong values: 0`, `lost: 0`, `verdict: PASS`. A short latency
spike (up to about 2 s) shows up in `max`: that is the time until the failure detector marks the
node down.

Try `--retries 0` to see why retries matter: requests that were already on their way to the dying
node now fail. Always run `docker compose down` and `up` again between runs, because the kill
command leaves node-c stopped.

## 5. The chaos demo on Kubernetes

```bash
kind create cluster --name cache
docker build -t self-healing-cache:dev .
kind load docker-image self-healing-cache:dev --name cache
kubectl apply -f k8s/
kubectl rollout status statefulset/cache --timeout=180s
```

In a second terminal (leave it running):

```bash
npm run k8s:forward
```

Then:

```bash
npm run chaos -- --duration 40 --kill-at 10 --settle 15 --retries 2 --kill "kubectl delete pod cache-1"
```

Kubernetes brings `cache-1` back with the same name and an empty memory; the peers refill it.
Clean up: `kind delete cluster --name cache`.

## 6. Quorum mode

```bash
docker compose -f docker-compose.yml -f docker-compose.quorum.yml up -d --build

curl -X PUT localhost:3001/keys/q -H "Content-Type: application/json" -d '{"value":"hello"}'
curl localhost:3003/keys/q                                   # hello

docker compose -f docker-compose.yml -f docker-compose.quorum.yml stop node-c
curl -X PUT localhost:3001/keys/q2 -H "Content-Type: application/json" -d '{"value":"two"}'   # still 200

docker compose -f docker-compose.yml -f docker-compose.quorum.yml stop node-b
curl -i -X PUT localhost:3001/keys/q3 -H "Content-Type: application/json" -d '{"value":"three"}'
# 503 {"error":"write quorum not reached","needed":2,"got":1}

docker compose -f docker-compose.yml -f docker-compose.quorum.yml down
```

One node down: still works (W=2 and R=2 are reachable). Two nodes down: the cache says **no**
instead of giving an answer that may be old. That is the consistency side of CAP.

## 7. LRU eviction

```bash
MAX_ENTRIES=3 npm start            # PowerShell: $env:MAX_ENTRIES="3"; npm start
for i in 1 2 3 4 5; do curl -s -X PUT localhost:3000/keys/k$i -H "Content-Type: application/json" -d "{\"value\":$i}"; done
curl -i localhost:3000/keys/k1     # 404: evicted (least recently used)
curl localhost:3000/keys/k5        # found
curl localhost:3000/stats          # {"keys":3,"maxEntries":3,"evictions":2}
```

Do not use `MAX_ENTRIES` for the chaos demo: an evicted key would count as lost.

## Recording a short video for LinkedIn (60 to 90 seconds)

1. Two terminals side by side, big font, dark theme.
2. Left: `docker compose up -d --build`, then the chaos command from demo 4.
3. Right: `docker compose logs -f` or `docker ps`, so people can see the node stop.
4. End on the result block (`verdict: PASS`).
5. Windows: Win + G (Xbox Game Bar) or ScreenToGif records a clip. Keep it under 90 seconds.