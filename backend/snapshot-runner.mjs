export function createSnapshotRunner(capture, reportError) {
  let pending = null;
  let stopping = false;
  return {
    run() {
      if (stopping) return Promise.resolve();
      if (!pending)
        pending = Promise.resolve()
          .then(capture)
          .catch(reportError)
          .finally(() => {
            pending = null;
          });
      return pending;
    },
    stop() {
      stopping = true;
      return pending || Promise.resolve();
    },
  };
}
