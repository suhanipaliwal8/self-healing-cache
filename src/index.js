import { Store } from './store.js';
import { createServer } from './server.js';
import { startSweeper } from './expiry.js';
import { Cluster } from './cluster.js';
import { FailureDetector } from './failure-detector.js';
import { Rebalancer } from './rebalancer.js';
import {
  loadConfig,
  loadReplicationConfig,
  loadFailureDetectorConfig,
  loadRebalanceConfig,
} from './config.js';

const { nodeId, port, nodes } = loadConfig();
const { replicationFactor, replicationMode } = loadReplicationConfig();
const heartbeat = loadFailureDetectorConfig();
const antiEntropy = loadRebalanceConfig();

let cluster;
if (nodes.length > 0) {
  cluster = new Cluster({ selfId: nodeId });
  for (const node of nodes) {
    cluster.addNode(node.id, node.url);
  }
}

const store = new Store();
startSweeper(store, 1000);

// The rebalancer keeps copies correct: it moves keys when nodes join or leave,
// and fills a node that came back empty.
const rebalancer = cluster ? new Rebalancer({ store, cluster, replicationFactor }) : undefined;

const server = createServer(store, { cluster, replicationFactor, replicationMode, rebalancer });
server.listen(port, () => {
  const mode = cluster
    ? `cluster of ${nodes.length}, replication factor ${replicationFactor} (${replicationMode})`
    : 'single-node mode';
  console.log(`${nodeId} listening on port ${port} (${mode})`);
  // Ask the others for the keys we should hold (we may be a node that just came back).
  void rebalancer?.reconcile();
});

if (cluster) {
  // Watch the other nodes with heartbeats. The member list can grow at runtime,
  // so we always run the detector.
  const detector = new FailureDetector({
    cluster,
    ...heartbeat,
    onChange: (id, status) => {
      console.log(`${nodeId}: ${id} is now ${status}`);
      if (status === 'up') void rebalancer.reconcile(); // catch the returning node up
    },
  });
  detector.start();
  rebalancer.start(antiEntropy.intervalMs);
}