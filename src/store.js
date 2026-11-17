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
export class Store {
  #data = new Map(); // key -> { value, expiresAt, version, writer, deleted }
  #now;
  #tombstoneTtlMs;

  // "now" is a function that returns the current time. Tests pass a fake
  // clock so they can "travel in time" without waiting.
  constructor({ now = Date.now, tombstoneTtlMs = 10 * 60 * 1000 } = {}) {
    this.#now = now;
    this.#tombstoneTtlMs = tombstoneTtlMs;
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
    this.#data.set(key, {
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

  // Returns { value, expiresAt } or undefined if missing, deleted or expired.
  // This is "lazy expiry": an expired key is removed the moment someone asks.
  getEntry(key) {
    const entry = this.#data.get(key);
    if (entry === undefined) return undefined;
    if (this.#isExpired(entry)) {
      this.#data.delete(key);
      return undefined;
    }
    if (entry.deleted) return undefined;
    return { value: entry.value, expiresAt: entry.expiresAt };
  }

  get(key) {
    return this.getEntry(key)?.value;
  }

  has(key) {
    return this.getEntry(key) !== undefined;
  }

  // Returns true if the key existed. Either way a tombstone is left behind, so
  // the delete also reaches copies that were not told about it yet.
  delete(key, { version, writer = '' } = {}) {
    const existed = this.getEntry(key) !== undefined;
    this.#putTombstone(key, version ?? this.#nextVersion(key), writer);
    return existed;
  }

  #putTombstone(key, version, writer) {
    this.#data.set(key, {
      value: null,
      expiresAt: this.#now() + this.#tombstoneTtlMs,
      version,
      writer,
      deleted: true,
    });
  }

  // ---------- used when nodes copy data to each other ----------

  // The full record for a key: live value OR tombstone (undefined if nothing
  // is stored or it expired).
  getRecord(key) {
    const entry = this.#data.get(key);
    if (entry === undefined) return undefined;
    if (this.#isExpired(entry)) {
      this.#data.delete(key);
      return undefined;
    }
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
  applyRecord(key, record) {
    if (record.deleted !== true && record.expiresAt !== null && record.expiresAt <= this.#now()) {
      return false; // it already expired on the way here
    }
    if (!isNewer(record, this.getRecord(key))) return false;
    this.#data.set(key, {
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
    return this.#data.delete(key);
  }

  // "Active expiry": remove every expired key (and old tombstone) now.
  // Returns how many were removed.
  sweep() {
    const now = this.#now();
    let removed = 0;
    for (const [key, entry] of this.#data) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) {
        this.#data.delete(key);
        removed++;
      }
    }
    return removed;
  }

  // Raw number of live keys. May include expired keys not yet swept.
  // Tombstones are not counted.
  get size() {
    let count = 0;
    for (const entry of this.#data.values()) if (!entry.deleted) count++;
    return count;
  }
}