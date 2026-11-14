// The Store is the "memory" of one cache node.
// Each entry remembers its value and an ABSOLUTE expiry time (milliseconds
// since 1970, like Date.now()), or null if the key never expires.
export class Store {
  #data = new Map(); // key -> { value, expiresAt }
  #now;

  // "now" is a function that returns the current time. Tests pass a fake
  // clock so they can "travel in time" without waiting.
  constructor({ now = Date.now } = {}) {
    this.#now = now;
  }

  // ttlMs: expire this many milliseconds from now.
  // expiresAt: expire at this exact time (used later when copying to replicas).
  // If neither is given, the key never expires.
  set(key, value, { ttlMs, expiresAt } = {}) {
    let expiry = null;
    if (expiresAt !== undefined) {
      expiry = expiresAt;
    } else if (ttlMs !== undefined) {
      expiry = this.#now() + ttlMs;
    }
    this.#data.set(key, { value, expiresAt: expiry });
  }

  // Returns { value, expiresAt } or undefined if missing or expired.
  // This is "lazy expiry": an expired key is removed the moment someone asks.
  getEntry(key) {
    const entry = this.#data.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= this.#now()) {
      this.#data.delete(key);
      return undefined;
    }
    return { value: entry.value, expiresAt: entry.expiresAt };
  }

  get(key) {
    return this.getEntry(key)?.value;
  }

  has(key) {
    return this.getEntry(key) !== undefined;
  }

  delete(key) {
    if (this.getEntry(key) === undefined) return false;
    return this.#data.delete(key);
  }

  // "Active expiry": remove every expired key now. Returns how many were removed.
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

  // Raw number of entries. May include expired keys not yet swept.
  get size() {
    return this.#data.size;
  }
}