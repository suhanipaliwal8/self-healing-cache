import { HashRing } from './hash-ring.js';

// A Cluster is one node's view of the whole cluster:
// "who am I, who else exists, and which node owns this key?"
// Every node builds its own Cluster from the same list, so they all agree.
export class Cluster {
  #ring;
  #urls = new Map(); // nodeId -> base URL, e.g. "http://localhost:3001"

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
  }

  // { id, url, isSelf } for the node that owns the key, or undefined if empty.
  ownerOf(key) {
    const id = this.#ring.getNode(key);
    if (id === undefined) return undefined;
    return { id, url: this.#urls.get(id), isSelf: id === this.selfId };
  }

  get nodes() {
    return [...this.#urls].map(([id, url]) => ({ id, url }));
  }
}