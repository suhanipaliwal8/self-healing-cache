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