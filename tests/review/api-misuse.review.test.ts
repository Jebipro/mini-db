import { describe, expect, it } from 'vitest';
import { Database } from '../../src/engine/database.js';
import { MiniDbError } from '../../src/errors/errors.js';
import { MemoryVfs } from '../../src/storage/memory-vfs.js';
import { deterministicEntropy } from '../support/db.js';

/**
 * REVIEW-API-001 (fail-first): wrong argument types from untyped (JavaScript) callers. SPEC H.2 lists
 * "UsageError — API 오용" (INVALID_OPTION), and DC-49/DC-51 reserve FAILED for storage failures, corruption and
 * engine bugs. Expected: a UsageError and a handle that stays usable. Observed: TypeError → InternalError
 * INVARIANT_VIOLATION and the handle is FAILED (must be closed and reopened).
 */

type Loose = { execute: (...a: unknown[]) => unknown; executeScript: (...a: unknown[]) => unknown };

function attempt(f: () => unknown): { name: string; code: string } {
  try {
    f();
    return { name: 'ok', code: 'ok' };
  } catch (e) {
    if (e instanceof MiniDbError) return { name: e.name, code: e.code };
    return { name: 'raw', code: String(e) };
  }
}

describe('REVIEW-API-001 API misuse must not fail the handle', () => {
  for (const [label, call] of [
    ['execute(undefined)', (db: Loose) => db.execute(undefined)],
    ['execute(42)', (db: Loose) => db.execute(42)],
    ["execute('SELECT * FROM t', null)", (db: Loose) => db.execute('SELECT * FROM t', null)],
    ['executeScript(null)', (db: Loose) => db.executeScript(null)],
  ] as const) {
    it(label, () => {
      const db = Database.open('m.db', { vfs: new MemoryVfs(), entropy: deterministicEntropy(1) });
      db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      const r = attempt(() => call(db as unknown as Loose));
      // record the observed behaviour in the failure message
      expect({ ...r, state: db.state }, `${label} observed`).toEqual({ name: 'UsageError', code: 'INVALID_OPTION', state: 'open' });
      db.close();
    });
  }
});
