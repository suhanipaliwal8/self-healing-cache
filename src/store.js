// The Store is the "memory" of one cache node.
// It is a thin wrapper around JavaScript's built-in Map.
export class Store {
  #data = new Map(); // "#" makes this private: only code inside Store can touch it

  set(key, value) {
    this.#data.set(key, value);
  }

  get(key) {
    return this.#data.get(key); // undefined if the key does not exist
  }

  has(key) {
    return this.#data.has(key);
  }

  delete(key) {
    return this.#data.delete(key); // true if the key existed, false otherwise
  }

  get size() {
    return this.#data.size;
  }
}