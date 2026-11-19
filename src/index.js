import { Store } from './store.js';
import { createServer } from './server.js';
import { startSweeper } from './expiry.js';
import { Cluster } from './cluster.js';
import { FailureDetector } from './failure-detector.js';
import { Rebalancer } from './rebalancer.js';
import { installShutdown } from './shutdown.js';
import {
  loadConfig,
  loadReplicationConfig,
  loadFailureDetectorConfig,
  loadRebalanceConfig,
  loadStoreConfig,
  loadQuorumConfig,
} from './config.js';

const { nodeId, port, nodes } = loadConfig();
const { replicationFactor, replicationMode } = loadReplicationConfig();
const { writeQuorum, readQuorum } = loadQuorumConfig(process.env, { replicationFactor, replicationMode });
if ((writeQuorum > 1 || readQuorum > 1) && writeQuorum + readQuorum <= replicationFactor) {
  console.warn(
    `warning: W=${writeQuorum} + R=${readQuorum} is not more than N=${replicationFactor}, so a read can still return an old value`,
  );
}
const heartbeat = loadFailureDetectorConfig();
const antiEntropy = loadRebalanceConfig();
const { maxEntries } = loadStoreConfig();

let cluster;
if (nodes.length > 0) {
  cluster = new Cluster({ selfId: nodeId });
  for (const node of nodes) {
    cluster.addNode(node.id, node.url);
  }
}

const store = new Store({ maxEntries });
const stopSweeper = startSweeper(store, 1000);

// The rebalancer keeps copies correct: it moves keys when nodes join or leave,
// and fills a node that came back empty.
const rebalancer = cluster ? new Rebalancer({ store, cluster, replicationFactor }) : undefined;

const server = createServer(store, {
  cluster,
  replicationFactor,
  replicationMode,
  writeQuorum,
  readQuorum,
  rebalancer,
});
server.listen(port, () => {
  const mode = cluster
    ? `cluster of ${nodes.length}, replication factor ${replicationFactor} (${replicationMode})`
    : 'single-node mode';
  const limit = maxEntries > 0 ? `, LRU limit ${maxEntries} keys` : '';
  const quorum = writeQuorum > 1 || readQuorum > 1 ? `, quorum W=${writeQuorum} R=${readQuorum}` : '';
  console.log(`${nodeId} listening on port ${port} (${mode}${limit}${quorum})`);
  // Ask the others for the keys we should hold (we may be a node that just came back).
  void rebalancer?.reconcile();
});

const stoppers = [stopSweeper];
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
  stoppers.push(() => detector.stop(), () => rebalancer.stop());
}

// Docker and Kubernetes stop us with SIGTERM: finish cleanly instead of being killed.
installShutdown({ server, stop: stoppers });