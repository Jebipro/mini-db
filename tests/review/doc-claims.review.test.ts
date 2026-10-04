import { describe, expect, it } from 'vitest';
import { Database } from '../../src/engine/database.js';
import { MemoryVfs } from '../../src/storage/memory-vfs.js';
import { PAGE_SIZE } from '../../src/storage/layout.js';
import type { Pager } from '../../src/storage/pager.js';
import { deterministicEntropy } from '../support/db.js';

/**
 * REVIEW-DOC-001: DURABILITY.md G.10 I1 states "data file size ≥ pageCount×4096 (= when the WAL is empty)".
 * A legitimate state with committed-but-not-checkpointed new pages has a SMALLER data file; the code (correctly)
 * only checks equality when the WAL is empty. This test pins the actual behaviour so the doc can be corrected.
 */
describe('REVIEW-DOC-001 I1 wording vs a legitimate state', () => {
  it('committed new pages live only in the WAL: data file < pageCount×4096 and integrity is ok', () => {
    const vfs = new MemoryVfs();
    const db = Database.open('d.db', { vfs, entropy: deterministicEntropy(2), walAutoCheckpointFrames: 0 });
    db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT)');
    db.execute('BEGIN');
    for (let i = 0; i < 50; i++) db.execute(`INSERT INTO t VALUES (${i}, '${'z'.repeat(1000)}')`);
    db.execute('COMMIT');
    const pager = (db as unknown as { pager: Pager }).pager;
    expect(pager.stats().wal.frames).toBeGreaterThan(0);
    expect(vfs.fileBytes('d.db').length).toBeLessThan(pager.pageCount * PAGE_SIZE);
    expect(db.integrityCheck().issues).toEqual([]);
    db.close();
  });

  it('design note: a rejected non-database file still gets an empty "-wal" side file created', () => {
    const vfs = new MemoryVfs();
    vfs.setFileBytes('notes.txt', new TextEncoder().encode('hello, this is not a database\n'.repeat(400)));
    let code = 'ok';
    try {
      Database.open('notes.txt', { vfs, entropy: deterministicEntropy(2) });
    } catch (e) {
      code = (e as { code?: string }).code ?? 'raw';
    }
    expect(code).toBe('NOT_A_DATABASE');
    expect(vfs.paths()).toEqual(['notes.txt', 'notes.txt-wal']);
    expect(vfs.fileBytes('notes.txt-wal').length).toBe(0);
  });
});
