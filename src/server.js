import http from 'node:http';

// A request body arrives in small pieces (chunks). We collect them all.
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function decodeKey(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

// Nodes we believe are up first; nodes the failure detector believes are down
// go to the back of the line. We only try them if everyone else failed, so a
// wrong guess by the detector never causes an outage.
function tryOrder(owners) {
  return [...owners.filter((o) => o.isUp), ...owners.filter((o) => !o.isUp)];
}

// Build (but do not start) an HTTP server that exposes a Store.
//
// Without a cluster it behaves like a single node.
// With a cluster, any node can receive any request: it is sent to the key's
// primary node. The primary stores the key and copies it to
// (replicationFactor - 1) replica nodes. If the primary cannot be reached,
// reads are answered by a replica and writes FAIL OVER to the next replica,
// which takes over as "acting primary".
export function createServer(
  store,
  { cluster, forwardTimeoutMs = 2000, replicationFactor = 1, replicationMode = 'sync' } = {},
) {
  // Send a JSON response. In a cluster we also say which node answered.
  function sendJson(res, status, body, extraHeaders = {}) {
    const payload = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      ...extraHeaders,
    };
    if (cluster) headers['x-served-by'] = cluster.selfId;
    res.writeHead(status, headers);
    res.end(payload);
  }

  const keyPath = (key) => `/keys/${encodeURIComponent(key)}`;
  const internalPath = (key) => `/internal/keys/${encodeURIComponent(key)}`;

  // Call another node. Resolves with its answer, or THROWS if the node cannot
  // be reached (connection refused, timeout, ...). An HTTP error status such
  // as 404 is still an answer and does not throw.
  async function callNode(node, method, path, rawBody, extraHeaders = {}) {
    const response = await fetch(`${node.url}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-cache-forwarded-by': cluster.selfId,
        ...extraHeaders,
      },
      body: rawBody,
      signal: AbortSignal.timeout(forwardTimeoutMs), // never wait forever
    });
    return {
      status: response.status,
      text: await response.text(),
      servedBy: response.headers.get('x-served-by') ?? node.id,
      replicatedTo: response.headers.get('x-replicated-to'),
    };
  }

  // Pass another node's answer straight back to our client.
  function relay(res, result, extraHeaders = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(result.text),
      'x-served-by': result.servedBy,
      ...extraHeaders,
    };
    if (result.replicatedTo) headers['x-replicated-to'] = result.replicatedTo;
    res.writeHead(result.status, headers);
    res.end(result.text);
  }

  function unreachableMessage(owners) {
    if (owners.length === 1) return `${owners[0].id} is unreachable`;
    return `every node holding this key is unreachable (${owners.map((o) => o.id).join(', ')})`;
  }

  // ---------- reads ----------

  function readLocal(res, key) {
    const entry = store.getEntry(key);
    if (!entry) {
      return sendJson(res, 404, { error: 'key not found' });
    }
    const body = { key, value: entry.value };
    if (entry.expiresAt !== null) {
      body.expiresAt = entry.expiresAt;
    }
    return sendJson(res, 200, body);
  }

  // Ask the primary first. If it cannot be reached, try the replicas in order.
  async function readFromOwners(res, key, owners) {
    for (const owner of tryOrder(owners)) {
      if (owner.isSelf) return readLocal(res, key);
      try {
        return relay(res, await callNode(owner, 'GET', keyPath(key)));
      } catch {
        // could not reach this copy: try the next one
      }
    }
    return sendJson(res, 502, { error: unreachableMessage(owners) });
  }

  // ---------- writes ----------

  // The other nodes that should hold a copy of this key (empty if we are not
  // one of the key's owners, or if replication is off).
  function replicaTargets(key) {
    if (!cluster || replicationFactor < 2) return [];
    const owners = cluster.ownersOf(key, replicationFactor);
    if (!owners.some((owner) => owner.isSelf)) return [];
    return owners.filter((owner) => !owner.isSelf);
  }

  // Send the change to every target. Never rejects: resolves with the ids of
  // the nodes that confirmed.
  async function sendToReplicas(targets, method, key, payload) {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const results = await Promise.allSettled(
      targets.map(async (node) => {
        const result = await callNode(node, method, internalPath(key), body);
        if (result.status !== 200) throw new Error(`status ${result.status}`);
        return node.id;
      }),
    );
    return results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  }

  // Copy a change to the replicas. Returns extra response headers.
  // `unreachable` = ids that the node who sent us this request already failed
  // to reach: we must not wait for them again.
  async function replicate(key, method, payload, unreachable = new Set()) {
    const targets = replicaTargets(key);
    if (targets.length === 0) return {};

    // Never wait for a replica we believe is down. We still send it the change
    // in the background, so it catches up if it turns out to be fine.
    const isSuspected = (node) => !node.isUp || unreachable.has(node.id);
    const suspected = targets.filter(isSuspected);
    const live = targets.filter((node) => !isSuspected(node));
    if (suspected.length > 0) void sendToReplicas(suspected, method, key, payload);
    if (live.length === 0) return {};

    const job = sendToReplicas(live, method, key, payload);
    if (replicationMode === 'async') return {}; // do not wait for the replicas
    const acked = await job;
    return acked.length > 0 ? { 'x-replicated-to': acked.join(',') } : {};
  }

  // Store a key on THIS node, then copy it to the other owners. This is what
  // the primary does, and also what a replica does when it takes over.
  async function applyPut(res, key, value, ttlMs, extraHeaders = {}, unreachable = new Set()) {
    store.set(key, value, { ttlMs });
    // Replicas receive the ABSOLUTE expiry time, so the key dies at the same
    // moment on every copy.
    const entry = store.getEntry(key);
    const headers = entry
      ? await replicate(key, 'PUT', { value: entry.value, expiresAt: entry.expiresAt }, unreachable)
      : {};
    return sendJson(res, 200, { ok: true }, { ...extraHeaders, ...headers });
  }

  async function applyDelete(res, key, extraHeaders = {}, unreachable = new Set()) {
    const deleted = store.delete(key);
    const headers = await replicate(key, 'DELETE', undefined, unreachable);
    return sendJson(res, 200, { deleted }, { ...extraHeaders, ...headers });
  }

  // Send a write to the key's owners, primary first. If the primary cannot be
  // reached, the next owner takes over (FAILOVER) and copies the write to the
  // others. `applyLocal` is what to do when we ourselves are the owner chosen.
  async function writeViaOwners(res, owners, method, key, rawBody, applyLocal) {
    const primary = owners[0];
    const failed = new Set(); // owners we could not reach during this request
    for (const owner of tryOrder(owners)) {
      // Tell the client when someone other than the primary served the write.
      const extra = owner.id === primary.id ? {} : { 'x-failed-over-from': primary.id };
      if (owner.isSelf) return applyLocal(extra, failed);
      try {
        // Pass on what we learned, so the node taking over does not waste a
        // whole timeout waiting for a node we already know is unreachable.
        const hint = failed.size > 0 ? { 'x-cache-unreachable': [...failed].join(',') } : {};
        return relay(res, await callNode(owner, method, keyPath(key), rawBody, hint), extra);
      } catch {
        failed.add(owner.id); // could not reach this owner: let the next one take over
      }
    }
    return sendJson(res, 502, { error: unreachableMessage(owners) });
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');

      // Health check: "are you alive?"
      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, { status: 'ok' });
      }

      // Cluster info: who am I and who do I think is in the cluster?
      if (cluster && req.method === 'GET' && url.pathname === '/cluster') {
        return sendJson(res, 200, { self: cluster.selfId, nodes: cluster.nodes });
      }

      // Internal endpoint: other nodes use it to copy a key to us. It stores
      // exactly what it is given (including the absolute expiresAt) and never
      // forwards or replicates again.
      const internalMatch = url.pathname.match(/^\/internal\/keys\/(.+)$/);
      if (internalMatch) {
        const key = decodeKey(internalMatch[1]);
        if (key === undefined) {
          return sendJson(res, 400, { error: 'invalid key encoding' });
        }
        if (req.method === 'PUT') {
          let parsed;
          try {
            parsed = JSON.parse(await readBody(req));
          } catch {
            return sendJson(res, 400, { error: 'body must be valid JSON' });
          }
          const valid =
            parsed !== null &&
            typeof parsed === 'object' &&
            'value' in parsed &&
            (parsed.expiresAt === null || Number.isFinite(parsed.expiresAt));
          if (!valid) {
            return sendJson(res, 400, {
              error: 'body must look like {"value": ..., "expiresAt": number or null}',
            });
          }
          store.set(key, parsed.value, { expiresAt: parsed.expiresAt });
          return sendJson(res, 200, { ok: true });
        }
        if (req.method === 'DELETE') {
          return sendJson(res, 200, { deleted: store.delete(key) });
        }
        return sendJson(res, 405, { error: 'method not allowed' });
      }

      // Everything else must look like /keys/<key>
      const match = url.pathname.match(/^\/keys\/(.+)$/);
      if (!match) {
        return sendJson(res, 404, { error: 'not found' });
      }

      const key = decodeKey(match[1]);
      if (key === undefined) {
        return sendJson(res, 400, { error: 'invalid key encoding' });
      }

      // Which nodes hold this key: [primary, replica, ...]. A request that was
      // already forwarded to us is always handled here, so nodes can never
      // bounce it around forever.
      const alreadyForwarded = req.headers['x-cache-forwarded-by'] !== undefined;
      const owners = cluster && !alreadyForwarded ? cluster.ownersOf(key, replicationFactor) : [];
      // Nodes the sender of a forwarded request could not reach (see writeViaOwners).
      const reportedUnreachable = new Set(
        (req.headers['x-cache-unreachable'] ?? '').split(',').filter(Boolean),
      );

      if (req.method === 'GET') {
        if (owners.length === 0) return readLocal(res, key);
        return readFromOwners(res, key, owners);
      }

      if (req.method === 'PUT') {
        const rawBody = await readBody(req);
        let parsed;
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          return sendJson(res, 400, { error: 'body must be valid JSON' });
        }
        if (parsed === null || typeof parsed !== 'object' || !('value' in parsed)) {
          return sendJson(res, 400, { error: 'body must look like {"value": ...}' });
        }
        let ttlMs;
        if ('ttl' in parsed) {
          const ttl = parsed.ttl;
          if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) {
            return sendJson(res, 400, { error: '"ttl" must be a positive number of seconds' });
          }
          ttlMs = ttl * 1000;
        }
        // Bad requests are rejected above, before anything is forwarded.
        const applyLocal = (extra = {}, failed = reportedUnreachable) =>
          applyPut(res, key, parsed.value, ttlMs, extra, failed);
        if (owners.length === 0) return applyLocal();
        return writeViaOwners(res, owners, 'PUT', key, rawBody, applyLocal);
      }

      if (req.method === 'DELETE') {
        const applyLocal = (extra = {}, failed = reportedUnreachable) =>
          applyDelete(res, key, extra, failed);
        if (owners.length === 0) return applyLocal();
        return writeViaOwners(res, owners, 'DELETE', key, undefined, applyLocal);
      }

      return sendJson(res, 405, { error: 'method not allowed' });
    } catch {
      return sendJson(res, 500, { error: 'internal error' });
    }
  });
}