// Ask a peer "are you alive?" by calling its /health endpoint.
// Any problem (refused connection, no answer in time, error status) = not alive.
async function httpPing(node, timeoutMs) {
  try {
    const response = await fetch(`${node.url}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// Heartbeat failure detector.
//
// Every intervalMs this node pings every other node. A node is marked DOWN
// only after `failureThreshold` failed pings IN A ROW (one lost ping can just
// be a hiccup). A single successful ping marks it UP again.
export class FailureDetector {
  #cluster;
  #intervalMs;
  #failureThreshold;
  #ping;
  #onChange;
  #failures = new Map(); // nodeId -> consecutive failed pings
  #timer;
  #checking = false;

  constructor({
    cluster,
    intervalMs = 1000,
    timeoutMs = 500,
    failureThreshold = 3,
    ping = (node) => httpPing(node, timeoutMs), // tests pass a fake ping
    onChange,
  }) {
    this.#cluster = cluster;
    this.#intervalMs = intervalMs;
    this.#failureThreshold = failureThreshold;
    this.#ping = ping;
    this.#onChange = onChange;
  }

  // One round: ping every other node at the same time and record the results.
  async checkOnce() {
    const peers = this.#cluster.nodes.filter((node) => node.id !== this.#cluster.selfId);
    await Promise.all(
      peers.map(async (peer) => {
        const alive = await this.#ping(peer);
        this.#record(peer.id, alive);
      }),
    );
  }

  #record(id, alive) {
    if (alive) {
      this.#failures.set(id, 0);
      if (!this.#cluster.isUp(id)) {
        this.#cluster.markUp(id);
        this.#onChange?.(id, 'up');
      }
      return;
    }
    const failures = (this.#failures.get(id) ?? 0) + 1;
    this.#failures.set(id, failures);
    if (failures >= this.#failureThreshold && this.#cluster.isUp(id)) {
      this.#cluster.markDown(id);
      this.#onChange?.(id, 'down');
    }
  }

  start() {
    if (this.#timer) return;
    this.#timer = setInterval(async () => {
      if (this.#checking) return; // the previous round is still running
      this.#checking = true;
      try {
        await this.checkOnce();
      } finally {
        this.#checking = false;
      }
    }, this.#intervalMs);
    this.#timer.unref(); // do not keep the process alive just for heartbeats
  }

  stop() {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }
}