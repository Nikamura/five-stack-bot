// Per-key serialization. Used to ensure all updates to a session
// (vote, lock evaluation, message edit) run end-to-end without interleaving.
//
// Single-process is enough at this scale (one bot, one SQLite file).

const chains = new Map<string, Promise<unknown>>();

export function withMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const settled = prev.then(
    () => undefined,
    () => undefined,
  );
  const next = settled.then(fn);
  chains.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}
