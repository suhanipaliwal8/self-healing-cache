// Thrown when a request still fails after every allowed attempt.
export class CacheError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CacheError';
  }
}

// These answers mean "this node has a problem right now": trying another node
// may work. Everything else (200, 404, 400, ...) is a real answer.
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

// A small client for the cache cluster.
//
// It knows the address of every node and spreads requests over them in turn
// (round robin). If a node does not answer, it retries on the NEXT node, up to
// `retries` times. Retrying is safe because every request is idempotent:
// doing a GET, PUT or DELETE twice leaves the cache in the same state.
export class CacheClient {
  #nodes;
  #retries;
  #timeoutMs;
  #fetch;
  #next = 0;

  // requests: calls made by the caller; retries: extra attempts we made;
  // failures: calls that still failed after every attempt.
  stats = { requests: 0, retries: 0, failures: 0 };

  constructor({ nodes, retries = 1, timeoutMs = 5000, fetchFn = fetch }) {
    if (!Array.isArray(nodes) || nodes.length === 0) {
      throw new Error('CacheClient needs at least one node URL');
    }
    this.#nodes = nodes.map((url) => url.replace(/\/+$/, ''));
    this.#retries = retries;
    this.#timeoutMs = timeoutMs;
    this.#fetch = fetchFn;
  }

  // Resolves with { value, expiresAt }, or undefined if the key does not exist.
  async get(key) {
    const response = await this.#request('GET', key);
    if (response.status === 404) return undefined;
    await this.#expect(response, 'GET', key);
    const body = await response.json();
    return { value: body.value, expiresAt: body.expiresAt ?? null };
  }

  // ttl is in seconds (optional).
  async set(key, value, { ttl } = {}) {
    const body = ttl === undefined ? { value } : { value, ttl };
    const response = await this.#request('PUT', key, JSON.stringify(body));
    await this.#expect(response, 'PUT', key);
    return true;
  }

  // Resolves with true if the key existed.
  async delete(key) {
    const response = await this.#request('DELETE', key);
    await this.#expect(response, 'DELETE', key);
    return (await response.json()).deleted;
  }

  async #expect(response, method, key) {
    if (response.status === 200) return;
    throw new CacheError(`${method} ${key} was rejected with status ${response.status}`);
  }

  async #request(method, key, body) {
    this.stats.requests++;
    const attempts = this.#retries + 1;
    let lastProblem = 'no attempt was made';

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) this.stats.retries++;
      const node = this.#nodes[this.#next++ % this.#nodes.length];

      try {
        const response = await this.#fetch(`${node}/keys/${encodeURIComponent(key)}`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
        if (!RETRYABLE_STATUSES.has(response.status)) return response;
        await response.text().catch(() => {}); // free the connection
        lastProblem = `${node} answered ${response.status}`;
      } catch (error) {
        lastProblem = `${node} did not answer (${error.name})`;
      }
    }

    this.stats.failures++;
    throw new CacheError(`${method} ${key} failed after ${attempts} attempt(s): ${lastProblem}`);
  }
}