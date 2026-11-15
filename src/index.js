import { Store } from './store.js';
import { createServer } from './server.js';
import { startSweeper } from './expiry.js';
import { Cluster } from './cluster.js';
import { FailureDetector } from './failure-detector.js';
import { loadConfig, loadReplicationConfig, loadFailureDetectorConfig } from './config.js';

const { nodeId, port, nodes } = loadConfig();
const { replicationFactor, replicationMode } = loadReplicationConfig();
const heartbeat = loadFailureDetectorConfig();

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

// Watch the other nodes with heartbeats (only useful with 2 or more nodes).
if (cluster && nodes.length > 1) {
  const detector = new FailureDetector({
    cluster,
    ...heartbeat,
    onChange: (id, status) => console.log(`${nodeId}: ${id} is now ${status}`),
  });
  detector.start();
}