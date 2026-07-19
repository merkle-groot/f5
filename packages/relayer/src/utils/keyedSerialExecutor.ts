/**
 * Serialize signer work per chain/account while allowing unrelated destinations to
 * proceed in parallel.
 *
 * Ported from the app server, where it guarded one signer against concurrent user
 * requests. It matters MORE here: the relayer is now the single writer, so the
 * background auto-activator and user-triggered withdrawals share a signer inside one
 * process and would otherwise race for the same nonce.
 *
 * Note the scope: this is per-process. Two relayer instances sharing a signing key
 * still collide — that has to be prevented operationally, not here.
 */
export class KeyedSerialExecutor {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    // `.catch` before `.then`: a failed task must not poison the queue for the next
    // caller, but it must still reject for its own caller (hence `current` is returned).
    const current = previous.catch(() => {}).then(task);
    this.tails.set(key, current);
    const cleanup = () => {
      if (this.tails.get(key) === current) this.tails.delete(key);
    };
    current.then(cleanup, cleanup);
    return current;
  }
}
