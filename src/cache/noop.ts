// NoopCache: always misses, never writes. Used as the default when REDIS_URL
// is unset (local dev without docker), or when a caller wants to disable
// caching for a single computation (e.g. inside the ingestion path).

import type { CacheProvider } from './types.js';

export class NoopCache implements CacheProvider {
  getOrCompute<T>(_key: string, _ttlMs: number, compute: () => Promise<T>): Promise<T> {
    return compute();
  }
  del(_key: string): Promise<void> {
    return Promise.resolve();
  }
  delPrefix(_prefix: string): Promise<number> {
    return Promise.resolve(0);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}
