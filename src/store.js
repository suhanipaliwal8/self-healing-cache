// Is record `a` newer than record `b`? Newest version wins ("last write wins").
// If two writes got exactly the same version, the writer's name breaks the tie,
// so every node picks the SAME winner. `b` may be undefined (nothing stored yet).
export function isNewer(a, b) {
  if (b === undefined) return true;
  if (a.version !== b.version) return a.version > b.version;
  return (a.writer ?? '') > (b.writer ?? '');
}

// The Store is the "memory" of one cache node.
// Each entry remembers its value, an ABSOLUTE expiry time (milliseconds since
// 1970, like Date.now()) or null, and a VERSION: the time of the write that
// created it. Versions let nodes agree which of two copies is the newer one.
//
// A delete does not just forget the key: it leaves a small "tombstone" with a
// version. Without it, a node that missed the delete would later hand the old
// value back to everyone ("resurrection"). Tombstones disappear after a while.
//
// MEMORY LIMIT (LRU): with maxEntries > 0 the store keeps at most that many
// LIVE keys. When a new key does not fit, the Least Recently Used key goes.
// A JavaScript Map remembers insertion order, so:
//   - the FIRST key in the Map is the least recently used one,
//   - every time a key is used we delete + set it again, which moves it to the END.
// Tombstones are never counted and never evicted (evicting one could bring a
// deleted key back to life).
export class Store {
  #data = new Map(); // key -> { value, expiresAt, version, writer, deleted }
  #now;
  #tombstoneTtlMs;
  #maxEntries;
  #live = 0; // how many non-deleted entries are in #data

  // Plain counters that the server shows on GET /stats.
  stats = { evictions: 0 };

  // "now" is a function that returns the current time. Tests pass a fake
  // clock so they can "travel in time" without waiting.
  // maxEntries: 0 means "no limit" (the old behaviour).
  constructor({ now = Date.now, tombstoneTtlMs = 10 * 60 * 1000, maxEntries = 0 } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 0) {
      throw new Error(`maxEntries must be a whole number >= 0, got ${maxEntries}`);
    }
    this.#now = now;
    this.#tombstoneTtlMs = tombstoneTtlMs;
    this.#maxEntries = maxEntries;
  }

  get maxEntries() {
    return this.#maxEntries;
  }

  // How many more NEW live keys fit before something would be evicted.
  get room() {
    return this.#maxEntries === 0 ? Infinity : this.#maxEntries - this.#live;
  }

  // ttlMs: expire this many milliseconds from now.
  // expiresAt: expire at this exact time (used when copying to replicas).
  // If neither is given, the key never expires.
  // version/writer: who wrote it and when. Normally the server passes them;
  // by default the version is "now" (and always newer than what is stored).
  set(key, value, { ttlMs, expiresAt, version, writer = '' } = {}) {
    let expiry = null;
    if (expiresAt !== undefined) {
      expiry = expiresAt;
    } else if (ttlMs !== undefined) {
      expiry = this.#now() + ttlMs;
    }
    this.#put(key, {
      value,
      expiresAt: expiry,
      version: version ?? this.#nextVersion(key),
      writer,
      deleted: false,
    });
  }

  #nextVersion(key) {
    const previous = this.#data.get(key);
    return Math.max(this.#now(), (previous?.version ?? 0) + 1);
  }

  #isExpired(entry) {
    return entry.expiresAt !== null && entry.expiresAt <= this.#now();
  }

  // ---------- the three places that change #data (so #live stays right) ----------

  // Put an entry at the END of the Map (= "most recently used"), then make
  // room if we are over the limit.
  #put(key, entry) {
    const old = this.#data.get(key);
    if (old !== undefined && !old.deleted) this.#live--;
    this.#data.delete(key); // delete first, so the key moves to the end
    this.#data.set(key, entry);
    if (!entry.deleted) this.#live++;
    this.#evictIfFull();
  }

  // Remove a key completely. Returns true if it was there.
  #drop(key) {
    const old = this.#data.get(key);
    if (old === undefined) return false;
    if (!old.deleted) this.#live--;
    return this.#data.delete(key);
  }

  // While we hold too many live keys, remove the least recently used one.
  // Tombstones are skipped: they do not count and must not be evicted.
  #evictIfFull() {
    if (this.#maxEntries === 0) return;
    while (this.#live > this.#maxEntries) {
      for (const [key, entry] of this.#data) {
        if (entry.deleted) continue;
        this.#drop(key);
        this.stats.evictions++;
        break;
      }
    }
  }

  // Look at an entry WITHOUT counting it as "used". An expired entry is removed
  // on the spot ("lazy expiry").
  #peek(key) {
    const entry = this.#data.get(key);
    if (entry === undefined) return undefined;
    if (this.#isExpired(entry)) {
      this.#drop(key);
      return undefined;
    }
    return entry;
  }

  // ---------- reading ----------

  // Returns { value, expiresAt } or undefined if missing, deleted or expired.
  // A successful read counts as "use": the key moves to the end of the Map.
  getEntry(key) {
    const entry = this.#peek(key);
    if (entry === undefined || entry.deleted) return undefined;
    this.#data.delete(key);
    this.#data.set(key, entry);
    return { value: entry.value, expiresAt: entry.expiresAt };
  }

  get(key) {
    return this.getEntry(key)?.value;
  }

  // has() only asks "do you have it?", it does NOT count as use.
  has(key) {
    const entry = this.#peek(key);
    return entry !== undefined && !entry.deleted;
  }

  // Returns true if the key existed. Either way a tombstone is left behind, so
  // the delete also reaches copies that were not told about it yet.
  delete(key, { version, writer = '' } = {}) {
    const existed = this.has(key);
    this.#putTombstone(key, version ?? this.#nextVersion(key), writer);
    return existed;
  }

  #putTombstone(key, version, writer) {
    this.#put(key, {
      value: null,
      expiresAt: this.#now() + this.#tombstoneTtlMs,
      version,
      writer,
      deleted: true,
    });
  }

  // ---------- used when nodes copy data to each other ----------

  // The full record for a key: live value OR tombstone (undefined if nothing
  // is stored or it expired). Does NOT count as use, so the background digests
  // of anti-entropy never disturb the LRU order.
  getRecord(key) {
    const entry = this.#peek(key);
    if (entry === undefined) return undefined;
    return { ...entry };
  }

  // Every live record and tombstone as [key, record] pairs.
  *records() {
    for (const key of [...this.#data.keys()]) {
      const record = this.getRecord(key);
      if (record !== undefined) yield [key, record];
    }
  }

  // Store a record that came from another node, but ONLY if it is newer than
  // what we have. Returns true if we took it. Running the same record twice
  // changes nothing the second time, so copying is always safe to repeat.
  //
  // evict: false is for BACKGROUND copying (the Rebalancer). If the record would
  // add a NEW live key and we are full, we refuse instead of evicting someone.
  // Otherwise eviction and anti-entropy would undo each other forever.
  // Updates of keys we already hold, and tombstones, are always accepted.
  applyRecord(key, record, { evict = true } = {}) {
    if (record.deleted !== true && record.expiresAt !== null && record.expiresAt <= this.#now()) {
      return false; // it already expired on the way here
    }
    const existing = this.getRecord(key);
    if (!isNewer(record, existing)) return false;

    const addsNewLiveKey = record.deleted !== true && (existing === undefined || existing.deleted);
    if (!evict && addsNewLiveKey && this.room <= 0) return false;

    this.#put(key, {
      value: record.deleted ? null : record.value,
      expiresAt: record.deleted ? (record.expiresAt ?? this.#now() + this.#tombstoneTtlMs) : record.expiresAt,
      version: record.version,
      writer: record.writer ?? '',
      deleted: record.deleted === true,
    });
    return true;
  }

  // Forget a key completely (no tombstone), but only if nobody wrote a newer
  // version meanwhile. Used when a key has moved to other nodes.
  removeIfUnchanged(key, { version, writer }) {
    const current = this.#data.get(key);
    if (current === undefined || current.version !== version || current.writer !== writer) return false;
    return this.#drop(key);
  }

  // "Active expiry": remove every expired key (and old tombstone) now.
  // Returns how many were removed.
  sweep() {
    const now = this.#now();
    let removed = 0;
    for (const [key, entry] of this.#data) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) {
        this.#drop(key);
        removed++;
      }
    }
    return removed;
  }

  // Number of live keys. May include expired keys not yet swept.
  // Tombstones are not counted. (O(1): we keep a running counter.)
  get size() {
    return this.#live;
  }
}