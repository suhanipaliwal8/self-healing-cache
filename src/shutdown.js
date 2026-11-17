// Stop the node cleanly when the system asks us to (SIGTERM, SIGINT).
//
// Docker and Kubernetes stop a container by sending SIGTERM and waiting a few
// seconds before they kill it for good. If we ignore SIGTERM, every stop is
// slow and ends with a hard kill. So we: stop the background timers, stop
// accepting new connections, let running requests finish, and exit.
//   stop      functions to call first (for example "stop the heartbeat")
//   graceMs   if requests have not finished by then, close them and exit anyway
export function installShutdown({
  server,
  stop = [],
  signals = ['SIGTERM', 'SIGINT'],
  graceMs = 5000,
  proc = process,
  exit = process.exit,
  log = console.log,
}) {
  let shuttingDown = false;

  function shutdown(signal) {
    if (shuttingDown) return; // a second signal changes nothing
    shuttingDown = true;
    log(`${signal} received, shutting down`);

    for (const stopOne of stop) stopOne();

    const timer = setTimeout(() => {
      log('requests did not finish in time, closing them');
      server.closeAllConnections();
      exit(1);
    }, graceMs);
    timer.unref();

    server.close(() => {
      clearTimeout(timer);
      exit(0);
    });
    server.closeIdleConnections(); // keep-alive connections that nobody is using
  }

  for (const signal of signals) proc.on(signal, () => shutdown(signal));
  return shutdown;
}