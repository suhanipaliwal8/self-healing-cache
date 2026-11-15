import { Store } from './store.js';
import { createServer } from './server.js';
import { startSweeper } from './expiry.js';
import { Cluster } from './cluster.js';
import { loadConfig, loadReplicationConfig } from './config.js';

const { nodeId, port, nodes } = loadConfig();
const { replicationFactor, replicationMode } = loadReplicationConfig();

let cluster;
if (nodes.length > 0) {
  cluster = new Cluster({ selfId: nodeId });
  for (const node of nodes) {
    cluster.addNode(node.id, node.url);
  }
}

const store = new Store();
startSweeper(store, 1000);

const server = createServer(store, { cluster, replicationFactor, replicationMode });
server.listen(port, () => {
  const mode = cluster
    ? `cluster of ${nodes.length}, replication factor ${replicationFactor} (${replicationMode})`
    : 'single-node mode';
  console.log(`${nodeId} listening on port ${port} (${mode})`);
});