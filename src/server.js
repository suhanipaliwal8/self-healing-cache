import http from 'node:http';

// A request body arrives in small pieces (chunks). We collect them all.
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Build (but do not start) an HTTP server that exposes a Store.
//
// Without a cluster it behaves like a single node.
// With a cluster, any node can receive any request: if the key belongs to
// another node, this node forwards the request to the owner and relays the
// answer. The client never needs to know who owns what.
export function createServer(store, { cluster, forwardTimeoutMs = 2000 } = {}) {
  // Send a JSON response. In a cluster we also say which node answered.
  function sendJson(res, status, body, servedBy = cluster?.selfId) {
    const payload = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    };
    if (servedBy) headers['x-served-by'] = servedBy;
    res.writeHead(status, headers);
    res.end(payload);
  }

  // Forward a request to the node that owns the key and relay its answer.
  async function proxy(res, owner, method, key, rawBody) {
    try {
      const upstream = await fetch(`${owner.url}/keys/${encodeURIComponent(key)}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'x-cache-forwarded-by': cluster.selfId,
        },
        body: rawBody,
        signal: AbortSignal.timeout(forwardTimeoutMs), // never wait forever
      });
      const text = await upstream.text();
      res.writeHead(upstream.status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(text),
        'x-served-by': upstream.headers.get('x-served-by') ?? owner.id,
      });
      res.end(text);
    } catch {
      sendJson(res, 502, { error: `node ${owner.id} is unreachable` });
    }
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

      // Everything else must look like /keys/<key>
      const match = url.pathname.match(/^\/keys\/(.+)$/);
      if (!match) {
        return sendJson(res, 404, { error: 'not found' });
      }

      let key;
      try {
        key = decodeURIComponent(match[1]);
      } catch {
        return sendJson(res, 400, { error: 'invalid key encoding' });
      }

      // Who should handle this key? A request that was already forwarded to
      // us is always handled here, so two nodes can never bounce it forever.
      const alreadyForwarded = req.headers['x-cache-forwarded-by'] !== undefined;
      const owner = cluster && !alreadyForwarded ? cluster.ownerOf(key) : undefined;
      const remoteOwner = owner && !owner.isSelf ? owner : undefined;

      if (req.method === 'GET') {
        if (remoteOwner) {
          return proxy(res, remoteOwner, 'GET', key);
        }
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
        if (remoteOwner) {
          return proxy(res, remoteOwner, 'PUT', key, rawBody);
        }
        store.set(key, parsed.value, { ttlMs });
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'DELETE') {
        if (remoteOwner) {
          return proxy(res, remoteOwner, 'DELETE', key);
        }
        const deleted = store.delete(key);
        return sendJson(res, 200, { deleted });
      }

      return sendJson(res, 405, { error: 'method not allowed' });
    } catch {
      return sendJson(res, 500, { error: 'internal error' });
    }
  });
}