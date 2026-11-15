// Parse "node-a=http://localhost:3001,node-b=http://localhost:3002"
// into [{ id: 'node-a', url: 'http://localhost:3001' }, ...].
export function parseCluster(text) {
  if (!text) return [];
  const seen = new Set();
  return text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf('=');
      if (eq <= 0 || eq === part.length - 1) {
        throw new Error(`Invalid cluster entry "${part}", expected id=url`);
      }
      const id = part.slice(0, eq);
      const url = part.slice(eq + 1);
      if (seen.has(id)) {
        throw new Error(`Duplicate node id "${id}" in CLUSTER`);
      }
      seen.add(id);
      return { id, url };
    });
}

// Replication settings from environment variables.
//   REPLICATION_FACTOR  total copies of every key, primary included (default 2)
//   REPLICATION_MODE    "sync" waits for replicas, "async" does not (default sync)
export function loadReplicationConfig(env = process.env) {
  const factorText = env.REPLICATION_FACTOR ?? '2';
  const replicationFactor = Number(factorText);
  if (!Number.isInteger(replicationFactor) || replicationFactor < 1) {
    throw new Error(`REPLICATION_FACTOR must be a whole number >= 1, got "${factorText}"`);
  }

  const replicationMode = env.REPLICATION_MODE ?? 'sync';
  if (replicationMode !== 'sync' && replicationMode !== 'async') {
    throw new Error(`REPLICATION_MODE must be "sync" or "async", got "${replicationMode}"`);
  }

  return { replicationFactor, replicationMode };
}

function positiveInteger(env, name, fallback) {
  const text = env[name];
  if (text === undefined) return fallback;
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a whole number >= 1, got "${text}"`);
  }
  return value;
}

// Heartbeat settings from environment variables.
//   HEARTBEAT_INTERVAL_MS  how often to ping every other node (default 1000)
//   HEARTBEAT_TIMEOUT_MS   how long to wait for one answer (default 500)
//   FAILURE_THRESHOLD      failed pings in a row before "down" (default 3)
export function loadFailureDetectorConfig(env = process.env) {
  return {
    intervalMs: positiveInteger(env, 'HEARTBEAT_INTERVAL_MS', 1000),
    timeoutMs: positiveInteger(env, 'HEARTBEAT_TIMEOUT_MS', 500),
    failureThreshold: positiveInteger(env, 'FAILURE_THRESHOLD', 3),
  };
}

// Read settings from environment variables.
//   NODE_ID  who this node is (must appear in CLUSTER)
//   CLUSTER  every node in the cluster, as id=url pairs
//   PORT     optional, defaults to the port in this node's own URL
// With no CLUSTER we run as a plain single node (the Phase 1-3 behaviour).
export function loadConfig(env = process.env) {
  const nodes = parseCluster(env.CLUSTER);

  if (nodes.length === 0) {
    return { nodeId: env.NODE_ID ?? 'node-1', port: Number(env.PORT) || 3000, nodes: [] };
  }

  const nodeId = env.NODE_ID;
  const self = nodes.find((node) => node.id === nodeId);
  if (!self) {
    throw new Error(`NODE_ID "${nodeId}" is not listed in CLUSTER`);
  }
  const port = Number(env.PORT) || Number(new URL(self.url).port) || 3000;
  return { nodeId, port, nodes };
}