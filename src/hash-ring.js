import { createHash } from 'node:crypto';

// Turn any string into a number between 0 and 4,294,967,295 (an unsigned
// 32-bit integer). The same input always gives the same number.
// We use MD5 only because it spreads values evenly, not for security.
export function hash32(input) {
  return createHash('md5').update(input).digest().readUInt32BE(0);
}

// A consistent hash ring.
//
// Imagine a circle with positions 0 ... 4,294,967,295. Every node is placed
// on the circle at many points ("virtual nodes"). To find the owner of a key,
// hash the key to a position and walk clockwise until you meet a node point.
export class HashRing {
  #vnodes;
  #points = []; // sorted by position: [{ hash, nodeId }]
  #nodes = new Set();

  constructor({ vnodes = 100 } = {}) {
    this.#vnodes = vnodes;
  }

  addNode(nodeId) {
    if (this.#nodes.has(nodeId)) return;
    this.#nodes.add(nodeId);
    for (let i = 0; i < this.#vnodes; i++) {
      this.#points.push({ hash: hash32(`${nodeId}#${i}`), nodeId });
    }
    this.#points.sort(
      (a, b) => a.hash - b.hash || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0),
    );
  }

  removeNode(nodeId) {
    if (!this.#nodes.delete(nodeId)) return;
    this.#points = this.#points.filter((point) => point.nodeId !== nodeId);
  }

  get nodes() {
    return [...this.#nodes];
  }

  get size() {
    return this.#nodes.size;
  }

  // Binary search: index of the first point at or after keyHash.
  // If we run off the end of the array we wrap around to index 0 (a circle!).
  #indexFor(keyHash) {
    let low = 0;
    let high = this.#points.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.#points[mid].hash < keyHash) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low === this.#points.length ? 0 : low;
  }

  // The single node that owns this key (undefined if the ring is empty).
  getNode(key) {
    if (this.#points.length === 0) return undefined;
    return this.#points[this.#indexFor(hash32(key))].nodeId;
  }

  // The first `count` DIFFERENT nodes clockwise from the key.
  // The first one is the primary owner; the rest are replica candidates.
  getNodes(key, count) {
    if (this.#points.length === 0) return [];
    const wanted = Math.min(count, this.#nodes.size);
    const result = [];
    let index = this.#indexFor(hash32(key));
    while (result.length < wanted) {
      const { nodeId } = this.#points[index];
      if (!result.includes(nodeId)) result.push(nodeId);
      index = (index + 1) % this.#points.length;
    }
    return result;
  }
}