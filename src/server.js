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

// Build (but do not start) an HTTP server that exposes a Store.
//
// Without a cluster it behaves like a single node.
// With a cluster, any node can receive any request: it is forwarded to the
// key's primary node. The primary stores the key and copies it to
// (replicationFactor - 1) replica nodes. Reads fall back to a replica when the
// primary cannot be reached.
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
  async function callNode(node, method, path, rawBody) {
    const response = await fetch(`${node.url}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-cache-forwarded-by': cluster.selfId,
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
  function relay(res, result) {
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(result.text),
      'x-served-by': result.servedBy,
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
    for (const owner of owners) {
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

  // Writes always go to the primary. (Phase 7 adds failover for writes.)
  async function writeViaPrimary(res, primary, method, key, rawBody) {
    try {
      return relay(res, await callNode(primary, method, keyPath(key), rawBody));
    } catch {
      return sendJson(res, 502, { error: `${primary.id} is unreachable` });
    }
  }

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
  async function replicate(key, method, payload) {
    const targets = replicaTargets(key);
    if (targets.length === 0) return {};
    const job = sendToReplicas(targets, method, key, payload);
    if (replicationMode === 'async') return {}; // do not wait for the replicas
    const acked = await job;
    return acked.length > 0 ? { 'x-replicated-to': acked.join(',') } : {};
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
      const primaryIsRemote = owners.length > 0 && !owners[0].isSelf;

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
        // Bad requests are rejected above, before any forwarding happens.
        if (primaryIsRemote) {
          return writeViaPrimary(res, owners[0], 'PUT', key, rawBody);
        }
        store.set(key, parsed.value, { ttlMs });
        // Replicas receive the ABSOLUTE expiry time, so the key dies at the
        // same moment on every copy.
        const entry = store.getEntry(key);
        const headers = entry
          ? await replicate(key, 'PUT', { value: entry.value, expiresAt: entry.expiresAt })
          : {};
        return sendJson(res, 200, { ok: true }, headers);
      }

      if (req.method === 'DELETE') {
        if (primaryIsRemote) {
          return writeViaPrimary(res, owners[0], 'DELETE', key);
        }
        const deleted = store.delete(key);
        const headers = await replicate(key, 'DELETE');
        return sendJson(res, 200, { deleted }, headers);
      }

      return sendJson(res, 405, { error: 'method not allowed' });
    } catch {
      return sendJson(res, 500, { error: 'internal error' });
    }
  });
}