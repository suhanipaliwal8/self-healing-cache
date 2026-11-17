import { isNewer } from './store.js';

const CHUNK = 200; // how many records we send in one request

// Keeps the copies in the cluster correct. It does three jobs with ONE routine
// (reconcile), run at different moments:
//
//   1. REBALANCE: a node joined or left, so some keys have new owners.
//      Hand those keys to the new owners, then forget the ones we no longer own.
//   2. CATCH UP: a node came back (empty, or with old data). Peers send it
//      what it is missing and it asks for what it is missing.
//   3. ANTI-ENTROPY: now and then, compare notes with every peer anyway, so
//      copies that drifted apart (a missed write, a network cut) heal by themselves.
//
// To compare cheaply, nodes first exchange a DIGEST (key + version, no values)
// and only transfer the records that are missing or older.
export class Rebalancer {
  #store;
  #cluster;
  #replicationFactor;
  #timeoutMs;
  #fetch;
  #running = null; // the reconcile in progress, if any
  #again = false; // somebody asked for another round while one was running
  #timer;

  stats = { rounds: 0, sent: 0, received: 0, dropped: 0 };

  constructor({ store, cluster, replicationFactor = 2, timeoutMs = 2000, fetchFn = fetch }) {
    this.#store = store;
    this.#cluster = cluster;
    this.#replicationFactor = replicationFactor;
    this.#timeoutMs = timeoutMs;
    this.#fetch = fetchFn;
  }

  #owners(key) {
    return this.#cluster.ownersOf(key, this.#replicationFactor);
  }

  async #call(peer, method, path, body) {
    const response = await this.#fetch(`${peer.url}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-cache-forwarded-by': this.#cluster.selfId },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response.ok) throw new Error(`${peer.id} answered ${response.status}`);
    return response.json();
  }

  // Compare notes with ONE peer. Sends what the peer is missing, fetches what
  // we are missing. Resolves with the keys the peer is now known to hold (at
  // our version or newer), or null if the peer could not be reached.
  async syncWith(peer) {
    let digest;
    try {
      digest = (await this.#call(peer, 'GET', '/internal/digest')).entries;
    } catch {
      return null;
    }
    const theirs = new Map(digest.map((entry) => [entry.key, entry]));
    const confirmed = new Set();
    const toSend = [];
    const toFetch = [];

    for (const [key, record] of this.#store.records()) {
      if (!this.#owners(key).some((owner) => owner.id === peer.id)) continue;
      if (isNewer(record, theirs.get(key))) toSend.push({ key, ...record });
      else confirmed.add(key); // the peer already has this version or a newer one
    }
    for (const [key, theirRecord] of theirs) {
      if (!this.#owners(key).some((owner) => owner.isSelf)) continue;
      if (isNewer(theirRecord, this.#store.getRecord(key))) toFetch.push(key);
    }

    try {
      for (let i = 0; i < toSend.length; i += CHUNK) {
        const chunk = toSend.slice(i, i + CHUNK);
        await this.#call(peer, 'POST', '/internal/entries', { entries: chunk });
        for (const entry of chunk) confirmed.add(entry.key);
        this.stats.sent += chunk.length;
      }
      for (let i = 0; i < toFetch.length; i += CHUNK) {
        const { entries } = await this.#call(peer, 'POST', '/internal/fetch', {
          keys: toFetch.slice(i, i + CHUNK),
        });
        for (const { key, ...record } of entries) {
          if (this.#store.applyRecord(key, record)) this.stats.received++;
        }
      }
    } catch {
      // the peer went away half way: keep what we confirmed so far
    }
    return confirmed;
  }

  // One full round with every peer we believe is up, then forget the keys that
  // now belong to other nodes (only once ALL their new owners confirmed them).
  async #round() {
    const peers = this.#cluster.nodes.filter((node) => node.id !== this.#cluster.selfId && node.status === 'up');
    const results = await Promise.all(peers.map(async (peer) => [peer.id, await this.syncWith(peer)]));
    const confirmedBy = new Map(results.filter(([, confirmed]) => confirmed !== null));

    for (const [key, record] of this.#store.records()) {
      const owners = this.#owners(key);
      if (owners.length === 0 || owners.some((owner) => owner.isSelf)) continue;
      if (owners.every((owner) => confirmedBy.get(owner.id)?.has(key))) {
        if (this.#store.removeIfUnchanged(key, record)) this.stats.dropped++;
      }
    }
    this.stats.rounds++;
  }

  // Run a round. If one is already running, run exactly one more after it
  // (the cluster may have changed meanwhile). Resolves when it is all done.
  reconcile() {
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    this.#running = (async () => {
      try {
        do {
          this.#again = false;
          await this.#round();
        } while (this.#again);
      } finally {
        this.#running = null;
      }
    })();
    return this.#running;
  }

  // Compare notes with every peer every intervalMs (anti-entropy).
  start(intervalMs) {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.reconcile().catch(() => {}), intervalMs);
    this.#timer.unref();
  }

  stop() {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }
}