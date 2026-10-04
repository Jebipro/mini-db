import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

/** Per-test temporary directory, removed after each test (J.9). Call at module level of a test file. */
export function useTmpDir(): () => string {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return () => {
    const d = mkdtempSync(join(tmpdir(), 'minidb-'));
    dirs.push(d);
    return d;
  };
}
