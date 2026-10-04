import { describe, expect, it } from 'vitest';
import { Database } from '../../src/engine/database.js';
import { ConstraintError, InternalError, LimitError, TransactionError } from '../../src/errors/errors.js';
import { MemoryVfs } from '../../src/storage/memory-vfs.js';
import type { LockHandle, StorageFile, Vfs } from '../../src/storage/vfs.js';
import { deterministicEntropy, errOf, memDb, openDb, rows, run, sorted } from '../support/db.js';

describe('executor and Database API', () => {
  it('T-EXEC-001 create, insert, select, update, delete and reopen end to end', () => {
    const vfs = new MemoryVfs();
    const { db } = openDb(vfs);
    run(
      db,
      `CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, active BOOLEAN);
       INSERT INTO users VALUES (1, 'alice', TRUE), (2, 'bob', FALSE), (3, '한글', NULL);`,
    );
    expect(rows(db, 'SELECT name FROM users WHERE active ORDER BY id')).toEqual([['alice']]);
    expect(db.execute("UPDATE users SET active = TRUE, name = 'bobby' WHERE id = 2")).toEqual({ kind: 'changes', command: 'UPDATE', changes: 1 });
    expect(db.execute('DELETE FROM users WHERE active IS NULL')).toEqual({ kind: 'changes', command: 'DELETE', changes: 1 });
    db.close();
    const again = openDb(vfs).db;
    expect(rows(again, 'SELECT * FROM users ORDER BY id')).toEqual([
      [1, 'alice', true],
      [2, 'bobby', true],
    ]);
  });

  it('T-EXEC-002 a multi-row INSERT failing at row k inserts nothing (autocommit and explicit)', () => {
    const db = memDb();
    run(db, 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL); INSERT INTO t VALUES (1, \'a\')');
    const e = errOf(() => db.execute("INSERT INTO t VALUES (2, 'b'), (3, 'c'), (1, 'dup'), (4, 'd')"));
    expect(e).toBeInstanceOf(ConstraintError);
    expect(e.code).toBe('UNIQUE_VIOLATION');
    expect(e.position?.column).toBe(42); // the failing VALUES row
    expect(rows(db, 'SELECT id FROM t')).toEqual([[1]]);
    db.execute('BEGIN');
    db.execute("INSERT INTO t VALUES (10, 'x')");
    expect(errOf(() => db.execute("INSERT INTO t VALUES (11, 'y'), (12, NULL)")).code).toBe('NOT_NULL_VIOLATION');
    expect(db.inTransaction).toBe(true);
    db.execute('COMMIT');
    expect(rows(db, 'SELECT id FROM t ORDER BY id')).toEqual([[1], [10]]);
  });

  it('T-EXEC-003 UPDATE checks uniqueness per statement: id = id + 1 succeeds, collisions fail without partial effects', () => {
    const db = memDb();
    run(db, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'c')");
    db.execute('UPDATE t SET id = id + 1');
    expect(rows(db, 'SELECT id, v FROM t ORDER BY id')).toEqual([
      [2, 'a'],
      [3, 'b'],
      [4, 'c'],
    ]);
    expect(errOf(() => db.execute('UPDATE t SET id = 3 WHERE id = 2')).code).toBe('UNIQUE_VIOLATION');
    expect(errOf(() => db.execute('UPDATE t SET id = 7 WHERE id > 2')).code).toBe('UNIQUE_VIOLATION');
    expect(rows(db, 'SELECT id FROM t ORDER BY id')).toEqual([[2], [3], [4]]);
    db.execute('UPDATE t SET id = 5 - id'); // 2→3, 3→2, 4→1: a permutation
    expect(rows(db, 'SELECT id, v FROM t ORDER BY id')).toEqual([
      [1, 'c'],
      [2, 'b'],
      [3, 'a'],
    ]);
  });

  it('T-EXEC-004 an UPDATE that grows and moves rows updates each row exactly once (Halloween)', () => {
    const db = memDb();
    db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER NOT NULL, s TEXT)');
    for (let i = 0; i < 60; i++) db.execute(`INSERT INTO t VALUES (${i}, 0, 'x')`);
    const before = db.stats().cache.cached;
    expect(before).toBeGreaterThan(0);
    db.execute(`UPDATE t SET n = n + 1, s = '${'y'.repeat(1500)}'`);
    expect(rows(db, 'SELECT n FROM t WHERE n <> 1')).toEqual([]);
    expect(rows(db, 'SELECT id FROM t').length).toBe(60);
  });

  it('T-EXEC-005 ORDER BY puts NULL first ascending and last descending; multiple keys', () => {
    const db = memDb();
    run(db, "CREATE TABLE t (a INTEGER, b TEXT); INSERT INTO t VALUES (2, 'x'), (NULL, 'y'), (1, NULL), (2, 'a'), (NULL, NULL)");
    expect(rows(db, 'SELECT a FROM t ORDER BY a').map((r) => r[0])).toEqual([null, null, 1, 2, 2]);
    expect(rows(db, 'SELECT a FROM t ORDER BY a DESC').map((r) => r[0])).toEqual([2, 2, 1, null, null]);
    expect(rows(db, 'SELECT a, b FROM t ORDER BY a DESC, b')).toEqual([
      [2, 'a'],
      [2, 'x'],
      [1, null],
      [null, null],
      [null, 'y'],
    ]);
  });

  it('T-EXEC-006 LIMIT 0, OFFSET past the end, LIMIT/OFFSET boundaries', () => {
    const db = memDb();
    run(db, 'CREATE TABLE t (a INTEGER PRIMARY KEY); INSERT INTO t VALUES (1), (2), (3), (4), (5)');
    expect(rows(db, 'SELECT a FROM t ORDER BY a LIMIT 0')).toEqual([]);
    expect(rows(db, 'SELECT a FROM t ORDER BY a LIMIT 2')).toEqual([[1], [2]]);
    expect(rows(db, 'SELECT a FROM t ORDER BY a LIMIT 2 OFFSET 3')).toEqual([[4], [5]]);
    expect(rows(db, 'SELECT a FROM t ORDER BY a LIMIT 10 OFFSET 4')).toEqual([[5]]);
    expect(rows(db, 'SELECT a FROM t ORDER BY a LIMIT 3 OFFSET 5')).toEqual([]);
    expect(rows(db, 'SELECT a FROM t ORDER BY a LIMIT 3 OFFSET 100')).toEqual([]);
    expect(rows(db, 'SELECT a FROM t ORDER BY a DESC LIMIT 1')).toEqual([[5]]);
  });

  it('T-EXEC-007 NOT NULL and UNIQUE violations; PRIMARY KEY implies NOT NULL', () => {
    const db = memDb();
    db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL, w INTEGER)');
    expect(errOf(() => db.execute("INSERT INTO t (v) VALUES ('a')")).code).toBe('NOT_NULL_VIOLATION');
    expect(errOf(() => db.execute('INSERT INTO t (id) VALUES (1)')).code).toBe('NOT_NULL_VIOLATION');
    expect(errOf(() => db.execute("INSERT INTO t VALUES (NULL, 'a', 1)"))).toBeInstanceOf(ConstraintError);
    db.execute("INSERT INTO t VALUES (1, 'a', NULL), (2, 'b', NULL)");
    expect(errOf(() => db.execute('UPDATE t SET v = NULL WHERE id = 1')).code).toBe('NOT_NULL_VIOLATION');
    expect(errOf(() => db.execute("INSERT INTO t VALUES (2, 'c', 3)")).code).toBe('UNIQUE_VIOLATION');
    expect(rows(db, 'SELECT id, v FROM t ORDER BY id')).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
  });

  it('T-EXEC-008 transaction statement errors; an error inside a transaction keeps it and earlier changes', () => {
    const db = memDb();
    expect(errOf(() => db.execute('COMMIT')).code).toBe('TXN_NOT_ACTIVE');
    expect(errOf(() => db.execute('ROLLBACK'))).toBeInstanceOf(TransactionError);
    db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    db.execute('BEGIN');
    const nested = errOf(() => db.execute('BEGIN'));
    expect([nested.code, nested.position?.column]).toEqual(['TXN_ALREADY_ACTIVE', 1]);
    db.execute('INSERT INTO t VALUES (1)');
    expect(errOf(() => db.execute('INSERT INTO t VALUES (2), (1)')).code).toBe('UNIQUE_VIOLATION');
    expect(errOf(() => db.execute('SELECT * FROM nope')).code).toBe('TABLE_NOT_FOUND');
    db.execute('INSERT INTO t VALUES (3)');
    expect(rows(db, 'SELECT id FROM t ORDER BY id')).toEqual([[1], [3]]);
    db.execute('ROLLBACK');
    expect(rows(db, 'SELECT id FROM t')).toEqual([]);
  });

  it('T-EXEC-009 DDL inside an explicit transaction can be rolled back', () => {
    const db = memDb();
    db.execute('BEGIN');
    db.execute('CREATE TABLE t (a INTEGER)');
    db.execute('INSERT INTO t VALUES (1)');
    db.execute('ROLLBACK');
    expect(errOf(() => db.execute('SELECT * FROM t')).code).toBe('TABLE_NOT_FOUND');
    run(db, 'CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (5)');
    db.execute('BEGIN');
    db.execute('DROP TABLE t');
    expect(errOf(() => db.execute('SELECT * FROM t')).code).toBe('TABLE_NOT_FOUND');
    db.execute('ROLLBACK');
    expect(rows(db, 'SELECT a FROM t')).toEqual([[5]]);
  });

  it('T-CAT-005 catalog cache is invalidated after rollbacks of DDL', () => {
    const db = memDb();
    run(db, 'CREATE TABLE a (x INTEGER); INSERT INTO a VALUES (1), (2)');
    db.execute('BEGIN');
    db.execute('DROP TABLE a');
    db.execute('CREATE TABLE a (y TEXT)');
    db.execute("INSERT INTO a VALUES ('new')");
    expect(rows(db, 'SELECT * FROM a')).toEqual([['new']]);
    db.execute('ROLLBACK');
    expect(sorted(rows(db, 'SELECT x FROM a'))).toEqual([[1], [2]]);
    // a failing DDL statement inside a transaction rolls back only itself
    db.execute('BEGIN');
    db.execute('CREATE TABLE b (z INTEGER)');
    expect(errOf(() => db.execute('CREATE TABLE b (z INTEGER)')).code).toBe('OBJECT_EXISTS');
    db.execute('COMMIT');
    expect(rows(db, 'SELECT * FROM b')).toEqual([]);
  });

  it('T-EXEC-010 EXPLAIN SeqScan plans print exactly', () => {
    const db = memDb();
    db.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)');
    expect(rows(db, "EXPLAIN SELECT name FROM users WHERE age >= 30 AND name <> 'x' ORDER BY name LIMIT 10").map((r) => r[0])).toEqual([
      'Project columns=name',
      '  Limit limit=10 offset=0',
      '    Sort keys=name ASC',
      "      Filter predicate=((age >= 30) AND (name <> 'x'))",
      '        SeqScan table=users',
    ]);
    expect(rows(db, 'EXPLAIN SELECT * FROM users').map((r) => r[0])).toEqual(['Project columns=id, name, age', '  SeqScan table=users']);
    expect(rows(db, "EXPLAIN SELECT id FROM users WHERE NOT (age != -3) OR name IS NULL ORDER BY age DESC, id LIMIT 1 OFFSET 2").map((r) => r[0])).toEqual([
      'Project columns=id',
      '  Limit limit=1 offset=2',
      '    Sort keys=age DESC, id ASC',
      '      Filter predicate=((NOT (age <> (-3))) OR (name IS NULL))',
      '        SeqScan table=users',
    ]);
  });

  it('T-EXEC-011 result shapes, column names and * expansion', () => {
    const db = memDb();
    expect(db.execute('CREATE TABLE t (a INTEGER, b TEXT)')).toEqual({ kind: 'ok', command: 'CREATE TABLE' });
    expect(db.execute('SELECT * FROM t')).toEqual({ kind: 'rows', columns: ['a', 'b'], rows: [] });
    expect(db.execute("INSERT INTO t (b, a) VALUES ('x', 1), ('y', 2)")).toEqual({ kind: 'changes', command: 'INSERT', changes: 2 });
    expect(db.execute('SELECT b, a, b FROM t WHERE a = 1')).toEqual({ kind: 'rows', columns: ['b', 'a', 'b'], rows: [['x', 1, 'x']] });
    expect(db.execute('UPDATE t SET a = a WHERE a > 100')).toEqual({ kind: 'changes', command: 'UPDATE', changes: 0 });
    expect(db.execute('BEGIN')).toEqual({ kind: 'ok', command: 'BEGIN' });
    expect(db.execute('COMMIT')).toEqual({ kind: 'ok', command: 'COMMIT' });
    expect(db.execute('DROP TABLE t')).toEqual({ kind: 'ok', command: 'DROP TABLE' });
  });

  it('T-EXEC-012 execute() takes one statement; executeScript stops at the first error with statementIndex', () => {
    const db = memDb();
    expect(errOf(() => db.execute('')).code).toBe('SYNTAX_EMPTY_STATEMENT');
    expect(errOf(() => db.execute('BEGIN; COMMIT')).code).toBe('SYNTAX_MULTIPLE_STATEMENTS');
    db.execute('CREATE TABLE t (a INTEGER PRIMARY KEY);');
    const e = errOf(() => run(db, 'INSERT INTO t VALUES (1);; INSERT INTO t VALUES (2); INSERT INTO t VALUES (1); INSERT INTO t VALUES (3)'));
    expect([e.code, e.statementIndex]).toEqual(['UNIQUE_VIOLATION', 2]);
    expect(e.format().split('\n')[0]).toMatch(/\(statement 3\)$/);
    expect(rows(db, 'SELECT a FROM t ORDER BY a')).toEqual([[1], [2]]);
    const syn = errOf(() => run(db, 'INSERT INTO t VALUES (5); SELEC * FROM t'));
    expect([syn.code, syn.statementIndex]).toEqual(['SYNTAX_UNEXPECTED_TOKEN', 1]);
    expect(rows(db, 'SELECT a FROM t WHERE a = 5')).toEqual([[5]]);
    expect(run(db, ' ; -- nothing')).toEqual([]);
  });

  it('T-EXEC-013 row size boundary through SQL (4060 / 4061 bytes)', () => {
    const db = memDb();
    db.execute('CREATE TABLE t (a TEXT, b TEXT)');
    // row = 1 + 1 + (2 + 3000) + (2 + L) bytes
    db.execute(`INSERT INTO t VALUES ('${'a'.repeat(3000)}', '${'b'.repeat(4060 - 3006)}')`);
    const e = errOf(() => db.execute(`INSERT INTO t VALUES ('${'a'.repeat(3000)}', '${'b'.repeat(4061 - 3006)}')`));
    expect(e).toBeInstanceOf(LimitError);
    expect([e.code, e.position?.column]).toEqual(['ROW_TOO_LARGE', 22]);
    expect(errOf(() => db.execute(`UPDATE t SET b = '${'c'.repeat(1055)}'`)).code).toBe('ROW_TOO_LARGE');
    expect(rows(db, 'SELECT b FROM t')[0]?.[0]).toBe('b'.repeat(1054));
  });

  it('T-EXEC-014 closing with an open transaction rolls it back', () => {
    const vfs = new MemoryVfs();
    const { db } = openDb(vfs);
    run(db, 'CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1)');
    db.execute('BEGIN');
    db.execute('INSERT INTO t VALUES (2)');
    db.close();
    db.close();
    expect(errOf(() => db.execute('SELECT * FROM t')).code).toBe('DB_CLOSED');
    expect(rows(openDb(vfs).db, 'SELECT a FROM t')).toEqual([[1]]);
  });

  it('T-EXEC-015 TXN_TOO_LARGE keeps the explicit transaction usable', () => {
    const db = memDb({ cachePages: 64 });
    db.execute('CREATE TABLE t (s TEXT)');
    db.execute('BEGIN');
    db.execute("INSERT INTO t VALUES ('first')");
    const big = Array.from({ length: 40 }, () => `('${'x'.repeat(3000)}')`).join(', ');
    const e = errOf(() => db.execute(`INSERT INTO t VALUES ${big}`));
    expect(e.code).toBe('TXN_TOO_LARGE');
    expect(db.inTransaction).toBe(true);
    db.execute("INSERT INTO t VALUES ('second')");
    db.execute('COMMIT');
    expect(sorted(rows(db, 'SELECT s FROM t'))).toEqual([['first'], ['second']]);
  });

  it('T-LIM-001 column count, identifier length and text length limits through SQL', () => {
    const db = memDb();
    const cols = (n: number): string => Array.from({ length: n }, (_, i) => `c${i} INTEGER`).join(', ');
    db.execute(`CREATE TABLE wide (${cols(64)})`);
    expect(errOf(() => db.execute(`CREATE TABLE wider (${cols(65)})`)).code).toBe('TOO_MANY_COLUMNS');
    db.execute(`CREATE TABLE ${'n'.repeat(64)} (a INTEGER)`);
    expect(errOf(() => db.execute(`CREATE TABLE ${'n'.repeat(65)} (a INTEGER)`)).code).toBe('IDENTIFIER_TOO_LONG');
    db.execute('CREATE TABLE s (v TEXT)');
    db.execute(`INSERT INTO s VALUES ('${'é'.repeat(2000)}')`);
    expect(errOf(() => db.execute(`INSERT INTO s VALUES ('${'é'.repeat(2000)}x')`)).code).toBe('TEXT_TOO_LARGE');
  });

  it('T-STAT-001 fsync counts through SQL: autocommit write = 1 WAL sync, SELECT = 0', () => {
    const db = memDb();
    db.execute('CREATE TABLE t (a INTEGER)');
    db.resetStats();
    db.execute('INSERT INTO t VALUES (1)');
    expect(db.stats().io.walSyncs).toBe(1);
    db.resetStats();
    db.execute('SELECT * FROM t');
    expect(db.stats().io.walSyncs + db.stats().io.dataSyncs).toBe(0);
    db.execute('BEGIN');
    for (let i = 0; i < 10; i++) db.execute(`INSERT INTO t VALUES (${i})`);
    db.execute('COMMIT');
    expect(db.stats().io.walSyncs).toBe(1);
    expect(db.stats().txn.commits).toBe(1);
  });

  it('T-ERR-003 an unexpected non-MiniDb exception becomes InternalError and fails the handle', () => {
    const base = new MemoryVfs();
    let armed = false;
    const vfs: Vfs = {
      exists: (p) => base.exists(p),
      syncDir: (d) => base.syncDir(d),
      acquireLock: (p): LockHandle => base.acquireLock(p),
      open: (p): StorageFile => {
        const f = base.open(p);
        return {
          path: f.path,
          size: () => f.size(),
          read: (dst, pos) => {
            if (armed) throw new TypeError('boom');
            return f.read(dst, pos);
          },
          write: (src, pos) => f.write(src, pos),
          sync: () => f.sync(),
          truncate: (n) => f.truncate(n),
          close: () => f.close(),
        };
      },
    };
    const db = Database.open('x.db', { vfs, entropy: deterministicEntropy(), cachePages: 64 });
    run(db, 'CREATE TABLE t (a TEXT)');
    for (let i = 0; i < 100; i++) db.execute(`INSERT INTO t VALUES ('${'z'.repeat(3000)}')`); // 100 pages > 64-page cache
    db.checkpoint();
    for (let i = 0; i < 2; i++) db.execute('SELECT * FROM t'); // cycle the cache
    armed = true;
    const e = errOf(() => {
      for (let i = 0; i < 3; i++) db.execute('SELECT * FROM t');
    });
    expect(e).toBeInstanceOf(InternalError);
    expect(e.code).toBe('INVARIANT_VIOLATION');
    expect(db.state).toBe('failed');
    expect(errOf(() => db.execute('SELECT * FROM t')).code).toBe('DB_FAILED');
    db.close();
  });

  it('T-ERR-004 ill-typed public API arguments are UsageError INVALID_OPTION; the handle and an open transaction survive', () => {
    type Loose = { execute: (...a: unknown[]) => unknown; executeScript: (...a: unknown[]) => unknown };
    const vfs = new MemoryVfs();
    const { db } = openDb(vfs);
    run(db, 'CREATE TABLE t (id INTEGER PRIMARY KEY)');
    db.execute('BEGIN');
    db.execute('INSERT INTO t VALUES (1)');
    const loose = db as unknown as Loose;
    const misuse: Array<() => unknown> = [
      () => loose.execute(undefined),
      () => loose.execute(42),
      () => loose.execute('SELECT * FROM t', null),
      () => loose.execute('SELECT * FROM t', 'fast'),
      () => loose.execute('SELECT * FROM t', { forceSeqScan: 1 }),
      () => loose.executeScript(null),
      () => loose.executeScript('SELECT * FROM t', 'callback'),
    ];
    for (const call of misuse) {
      const e = errOf(call);
      expect(e.name).toBe('UsageError');
      expect(e.code).toBe('INVALID_OPTION');
      expect(db.state).toBe('open');
      expect(db.inTransaction).toBe(true);
    }
    expect(rows(db, 'SELECT id FROM t')).toEqual([[1]]);
    db.execute('INSERT INTO t VALUES (2)');
    db.execute('COMMIT');
    // valid calls behave as before: omitted options, explicit options, script without a callback
    expect(rows(db, 'SELECT id FROM t ORDER BY id', true)).toEqual([[1], [2]]);
    expect(db.execute('SELECT id FROM t WHERE id = 2', { forceSeqScan: false })).toEqual({ kind: 'rows', columns: ['id'], rows: [[2]] });
    expect(db.executeScript('SELECT id FROM t WHERE id = 1')).toHaveLength(1);
    db.close();
    expect(errOf(() => (db as unknown as Loose).execute(42)).code).toBe('DB_CLOSED'); // closed check comes first
    expect(rows(openDb(vfs).db, 'SELECT id FROM t ORDER BY id')).toEqual([[1], [2]]);
  });

  it('T-ERR-005 an exception thrown by the onResult callback propagates unchanged and never fails the handle', () => {
    const vfs = new MemoryVfs();
    const { db } = openDb(vfs);
    run(db, 'CREATE TABLE t (id INTEGER PRIMARY KEY)');
    const thrower = (at: number, err: unknown) => (_r: unknown, i: number): void => {
      if (i === at) throw err;
    };
    const catchAny = (f: () => unknown): unknown => {
      try {
        f();
      } catch (e) {
        return e;
      }
      throw new Error('expected a throw');
    };
    const ids = (): unknown[][] => rows(db, 'SELECT id FROM t ORDER BY id');

    // autocommit: statement 1 already committed when its callback throws; statement 2 never runs
    const boom = new Error('user callback failed');
    const e1 = catchAny(() => db.executeScript('INSERT INTO t VALUES (1); INSERT INTO t VALUES (2); INSERT INTO t VALUES (3)', thrower(1, boom)));
    expect(e1).toBe(boom); // same object: not wrapped, no statementIndex attached
    expect((boom as { statementIndex?: number }).statementIndex).toBeUndefined();
    expect(db.state).toBe('open');
    expect(db.inTransaction).toBe(false);
    expect(ids()).toEqual([[1], [2]]);

    // non-Error values propagate as they are
    expect(catchAny(() => db.executeScript('SELECT id FROM t', thrower(0, 'plain string')))).toBe('plain string');
    expect(db.state).toBe('open');

    // explicit transaction: BEGIN and the INSERT completed; the transaction stays open and can be committed
    const e2 = catchAny(() => db.executeScript('BEGIN; INSERT INTO t VALUES (10); INSERT INTO t VALUES (11)', thrower(1, boom)));
    expect(e2).toBe(boom);
    expect(db.state).toBe('open');
    expect(db.inTransaction).toBe(true);
    expect(ids()).toEqual([[1], [2], [10]]);
    db.execute('COMMIT');
    // …or rolled back
    expect(catchAny(() => db.executeScript('BEGIN; DELETE FROM t WHERE id = 1', thrower(1, boom)))).toBe(boom);
    expect(db.inTransaction).toBe(true);
    expect(ids()).toEqual([[2], [10]]);
    db.execute('ROLLBACK');
    expect(ids()).toEqual([[1], [2], [10]]);

    // a MiniDbError thrown by a nested call inside the callback keeps its own semantics (here: not FAILED)
    const nested = catchAny(() => db.executeScript('SELECT id FROM t', () => db.execute('INSERT INTO t VALUES (1)')));
    expect(nested instanceof ConstraintError && nested.code).toBe('UNIQUE_VIOLATION');
    expect((nested as ConstraintError).statementIndex).toBeUndefined();
    expect(db.state).toBe('open');

    db.close();
    const again = openDb(vfs).db;
    expect(rows(again, 'SELECT id FROM t ORDER BY id')).toEqual([[1], [2], [10]]);
  });

  it('T-LOCK-004 close releases the lock so the database can be reopened', () => {
    const vfs = new MemoryVfs();
    const { db } = openDb(vfs);
    expect(errOf(() => Database.open('test.db', { vfs })).code).toBe('DB_LOCKED');
    db.close();
    openDb(vfs);
  });
});

describe('integrity harness', () => {
  it('T-INTEG-001 databases opened by integration tests are integrity-checked at teardown (and pass now)', () => {
    const db = memDb();
    run(db, "CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT); CREATE INDEX i ON t (s); INSERT INTO t VALUES (1, 'a'), (2, 'b')");
    db.execute('UPDATE t SET s = s WHERE id = 1');
    db.execute('DELETE FROM t WHERE id = 2');
    const report = db.integrityCheck();
    expect(report.ok).toBe(true);
    expect(report.summary).toMatchObject({ tables: 1, indexes: 2, rows: 1, indexEntries: 2 });
    // the afterEach hook in tests/support/db.ts re-checks this database and fails the test on any issue
  });
});
