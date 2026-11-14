// Every intervalMs, ask the store to delete its expired keys.
// Returns a function that stops the sweeper.
export function startSweeper(store, intervalMs = 1000) {
  const timer = setInterval(() => store.sweep(), intervalMs);
  timer.unref(); // do not keep the process alive just for this timer
  return () => clearInterval(timer);
}