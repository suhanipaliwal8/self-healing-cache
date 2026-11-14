import http from 'node:http';

// Send a JSON response with the given HTTP status code.
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

// A request body arrives in small pieces (chunks). We collect them all.
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Build (but do not start) an HTTP server that exposes a Store.
export function createServer(store) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');

      // Health check: "are you alive?"
      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, { status: 'ok' });
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

      if (req.method === 'GET') {
        if (!store.has(key)) {
          return sendJson(res, 404, { error: 'key not found' });
        }
        return sendJson(res, 200, { key, value: store.get(key) });
      }

      if (req.method === 'PUT') {
        let parsed;
        try {
          parsed = JSON.parse(await readBody(req));
        } catch {
          return sendJson(res, 400, { error: 'body must be valid JSON' });
        }
        if (parsed === null || typeof parsed !== 'object' || !('value' in parsed)) {
          return sendJson(res, 400, { error: 'body must look like {"value": ...}' });
        }
        store.set(key, parsed.value);
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'DELETE') {
        const deleted = store.delete(key);
        return sendJson(res, 200, { deleted });
      }

      return sendJson(res, 405, { error: 'method not allowed' });
    } catch {
      return sendJson(res, 500, { error: 'internal error' });
    }
  });
}