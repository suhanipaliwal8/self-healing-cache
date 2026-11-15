import { HashRing } from './hash-ring.js';

// A Cluster is one node's view of the whole cluster:
// "who am I, who else exists, which node owns this key, and who is alive?"
// Every node builds its own Cluster from the same list, so they all agree
// on key ownership. Who is alive is each node's own opinion.
export class Cluster {
  #ring;
  #urls = new Map(); // nodeId -> base URL, e.g. "http://localhost:3001"
  #down = new Set(); // ids of nodes the failure detector believes are down

  constructor({ selfId, vnodes = 100 }) {
    this.selfId = selfId;
    this.#ring = new HashRing({ vnodes });
  }

  addNode(id, url) {
    this.#urls.set(id, url);
    this.#ring.addNode(id);
  }

  removeNode(id) {
    this.#urls.delete(id);
    this.#ring.removeNode(id);
    this.#down.delete(id);
  }

  // A node that is "down" stays on the ring: its keys keep the same owners,
  // we simply stop waiting for it. We never mark ourselves down.
  markDown(id) {
    if (id !== this.selfId && this.#urls.has(id)) this.#down.add(id);
  }

  markUp(id) {
    this.#down.delete(id);
  }

  isUp(id) {
    return !this.#down.has(id);
  }

  // { id, url, isSelf } for the node that owns the key, or undefined if empty.
  ownerOf(key) {
    const id = this.#ring.getNode(key);
    if (id === undefined) return undefined;
    return { id, url: this.#urls.get(id), isSelf: id === this.selfId };
  }

  // The first `count` distinct nodes for a key: [primary, replica, ...].
  // Each one is { id, url, isSelf, isUp }. The first is the same node ownerOf() gives.
  ownersOf(key, count = 1) {
    return this.#ring.getNodes(key, count).map((id) => ({
      id,
      url: this.#urls.get(id),
      isSelf: id === this.selfId,
      isUp: this.isUp(id),
    }));
  }

  get nodes() {
    return [...this.#urls].map(([id, url]) => ({
      id,
      url,
      status: this.isUp(id) ? 'up' : 'down',
    }));
  }
}