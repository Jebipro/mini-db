import { randomBytes } from 'node:crypto';
import { Catalog } from '../catalog/catalog.js';
import { assertNever } from '../errors/assert.js';
import { InternalError, MiniDbError, TransactionError, UsageError } from '../errors/errors.js';
import { executeCreateIndex, executeCreateTable, executeDropIndex, executeDropTable } from '../exec/ddl.js';
import { executeDelete, executeInsert, executeUpdate } from '../exec/dml.js';
import { explainPlan } from '../exec/explain.js';
import { collectRows, type ExecContext } from '../exec/operators.js';
import type { PlanOptions } from '../exec/plan.js';
import { planSelect } from '../exec/planner.js';
import type { Value } from '../record/value.js';
import { analyze } from '../sql/analyzer.js';
import type { Statement } from '../sql/ast.js';
import type { BoundStatement } from '../sql/bound.js';
import { parseStatement, ScriptParser } from '../sql/parser.js';
import { DEFAULT_CACHE_PAGES, DEFAULT_WAL_AUTOCHECKPOINT_FRAMES } from '../storage/layout.js';
import { NodeVfs } from '../storage/node-vfs.js';
import { Pager, type PagerStats } from '../storage/pager.js';
import type { Vfs } from '../storage/vfs.js';
import { checkIntegrity, type IntegrityReport } from './integrity.js';

export interface OpenOptions {
  vfs?: Vfs;
  cachePages?: number;
  walAutoCheckpointFrames?: number;
  entropy?: (n: number) => Uint8Array;
}

export type ExecResult =
  | { kind: 'rows'; columns: string[]; rows: Value[][] }
  | { kind: 'changes'; command: 'INSERT' | 'UPDATE' | 'DELETE'; changes: number }
  | { kind: 'ok'; command: 'CREATE TABLE' | 'DROP TABLE' | 'CREATE INDEX' | 'DROP INDEX' | 'BEGIN' | 'COMMIT' | 'ROLLBACK' };

export interface ExecuteOptions {
  /** Testing/learning aid: never use an index (DC-59). */
  forceSeqScan?: boolean;
}

export type DbStats = PagerStats;

export interface TableInfo {
  name: string;
  columns: Array<{ name: string; type: 'INTEGER' | 'TEXT' | 'BOOLEAN'; notNull: boolean; primaryKey: boolean }>;
  indexes: Array<{ name: string; column: string; unique: boolean; auto: boolean }>;
}
export type { IntegrityReport };

/** Errors that are not MiniDbErrors (or are InternalErrors) are bugs: wrap and fail the handle (DC-51). */
function isSimulatedCrash(e: unknown): boolean {
  return e instanceof Error && e.name === 'SimulatedCrash';
}

/**
 * Carries an exception thrown by user code (the executeScript onResult callback) through `guard` untouched:
 * it is not an engine failure, so it must not become InternalError or fail the handle (DEC-008).
 */
class UserCallbackFailure {
  constructor(readonly error: unknown) {}
}

function kindOf(v: unknown): string {
  return v === null ? 'null' : typeof v;
}

/**
 * Argument checks at the public boundary for untyped (JavaScript) callers. Misuse is a UsageError and leaves the
 * handle and any open transaction untouched; only engine-side failures enter FAILED (DC-49, DC-51).
 */
function checkSql(sql: unknown, method: string): string {
  if (typeof sql !== 'string') throw new UsageError('INVALID_OPTION', `${method}: sql must be a string, not ${kindOf(sql)}`);
  return sql;
}

function checkExecuteOptions(opts: unknown): ExecuteOptions {
  if (opts === undefined) return {};
  if (typeof opts !== 'object' || opts === null) throw new UsageError('INVALID_OPTION', `execute: options must be an object, not ${kindOf(opts)}`);
  const force = (opts as { forceSeqScan?: unknown }).forceSeqScan;
  if (force !== undefined && typeof force !== 'boolean') {
    throw new UsageError('INVALID_OPTION', `execute: forceSeqScan must be a boolean, not ${kindOf(force)}`);
  }
  return opts as ExecuteOptions;
}

/**
 * Public API (E.4). Single connection, synchronous. Every statement runs inside a transaction
 * (implicit autocommit or the explicit one) and inside a statement savepoint (DC-23).
 */
export class Database {
  private catalogCache: Catalog | null = null;

  private constructor(private readonly pager: Pager) {}

  static open(path: string, options: OpenOptions = {}): Database {
    const pager = Pager.open(options.vfs ?? new NodeVfs(), path, {
      cachePages: options.cachePages ?? DEFAULT_CACHE_PAGES,
      walAutoCheckpointFrames: options.walAutoCheckpointFrames ?? DEFAULT_WAL_AUTOCHECKPOINT_FRAMES,
      entropy: options.entropy ?? ((n) => new Uint8Array(randomBytes(n))),
      initialize: Catalog.initialize,
    });
    const db = new Database(pager);
    try {
      db.catalog(); // validate the catalog at open (CATALOG_INVALID fails the open)
    } catch (e) {
      pager.close();
      throw e;
    }
    return db;
  }

  get state(): 'open' | 'failed' | 'closed' {
    return this.pager.state;
  }

  get inTransaction(): boolean {
    return this.pager.state === 'open' && this.pager.inTxn();
  }

  private catalog(): Catalog {
    if (!this.catalogCache) this.catalogCache = Catalog.load(this.pager);
    return this.catalogCache;
  }

  /** DC-51: non-MiniDb errors and InternalErrors fail the handle. */
  private wrap(e: unknown): unknown {
    if (isSimulatedCrash(e)) return e;
    if (!(e instanceof MiniDbError)) {
      const err = new InternalError('INVARIANT_VIOLATION', `unexpected error: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      this.pager.markFailed(err);
      return err;
    }
    if (e.name === 'InternalError' || e.name === 'CorruptionError') this.pager.markFailed(e);
    return e;
  }

  private guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof UserCallbackFailure) throw e.error;
      throw this.wrap(e);
    }
  }

  execute(sql: string, opts?: ExecuteOptions): ExecResult {
    return this.guard(() => {
      this.pager.ensureUsable();
      const text = checkSql(sql, 'execute');
      return this.run(parseStatement(text), text, checkExecuteOptions(opts));
    });
  }

  /** Runs statements in order; onResult sees each result as it completes (CLI prints before a later error). */
  executeScript(sql: string, onResult?: (r: ExecResult, index: number) => void): ExecResult[] {
    return this.guard(() => {
      this.pager.ensureUsable();
      checkSql(sql, 'executeScript');
      if (onResult !== undefined && typeof onResult !== 'function') {
        throw new UsageError('INVALID_OPTION', `executeScript: onResult must be a function, not ${kindOf(onResult)}`);
      }
      const results: ExecResult[] = [];
      const parser = new ScriptParser(sql);
      for (;;) {
        let next: ReturnType<ScriptParser['next']>;
        try {
          next = parser.next();
        } catch (e) {
          if (e instanceof MiniDbError) e.statementIndex = parser.count;
          throw e;
        }
        if (next === null) return results;
        let r: ExecResult;
        try {
          r = this.run(next.stmt, sql, {});
        } catch (e) {
          if (e instanceof MiniDbError) e.statementIndex = parser.count - 1;
          throw e;
        }
        results.push(r);
        // the statement is complete (committed, or released inside an explicit transaction) before user code runs
        try {
          onResult?.(r, results.length - 1);
        } catch (e) {
          throw new UserCallbackFailure(e);
        }
      }
    });
  }

  private run(stmt: Statement, source: string, opts: ExecuteOptions): ExecResult {
    const pager = this.pager;
    pager.ensureUsable();
    if (!pager.inTxn()) pager.maybeCheckpoint(); // DC-26: a due checkpoint runs before the next statement
    switch (stmt.kind) {
      case 'begin':
        if (pager.inTxn()) throw new TransactionError('TXN_ALREADY_ACTIVE', 'a transaction is already active', { position: stmt.pos, source });
        pager.beginTxn();
        return { kind: 'ok', command: 'BEGIN' };
      case 'commit':
        if (!pager.inTxn()) throw new TransactionError('TXN_NOT_ACTIVE', 'no active transaction', { position: stmt.pos, source });
        pager.commitTxn();
        return { kind: 'ok', command: 'COMMIT' };
      case 'rollback':
        if (!pager.inTxn()) throw new TransactionError('TXN_NOT_ACTIVE', 'no active transaction', { position: stmt.pos, source });
        this.catalogCache = null;
        pager.rollbackTxn();
        return { kind: 'ok', command: 'ROLLBACK' };
      default:
        break;
    }
    const bound = analyze(stmt, this.catalog(), source);
    const explicit = pager.inTxn();
    if (!explicit) pager.beginTxn();
    pager.beginStatement();
    let result: ExecResult;
    try {
      result = this.exec(bound, { pager, source }, { forceSeqScan: opts.forceSeqScan ?? false });
      pager.releaseStatement();
    } catch (e) {
      this.catalogCache = null;
      if (pager.state === 'open') {
        if (pager.inStatement()) pager.rollbackStatement();
        if (!explicit && pager.inTxn()) pager.rollbackTxn();
      }
      throw e;
    }
    if (!explicit) {
      try {
        pager.commitTxn();
      } catch (e) {
        this.catalogCache = null;
        throw e;
      }
    }
    return result;
  }

  private exec(b: BoundStatement, ctx: ExecContext, opts: PlanOptions): ExecResult {
    switch (b.kind) {
      case 'select': {
        const rows = collectRows(planSelect(b, opts), ctx).map((r) => r.values);
        return { kind: 'rows', columns: b.columns.map((c) => b.table.columns[c]?.name ?? '?'), rows };
      }
      case 'explain':
        return { kind: 'rows', columns: ['plan'], rows: explainPlan(planSelect(b.select, opts)).map((l) => [l]) };
      case 'insert':
        return { kind: 'changes', command: 'INSERT', changes: executeInsert(b, ctx) };
      case 'update':
        return { kind: 'changes', command: 'UPDATE', changes: executeUpdate(b, ctx, opts) };
      case 'delete':
        return { kind: 'changes', command: 'DELETE', changes: executeDelete(b, ctx, opts) };
      case 'createTable':
        executeCreateTable(b, ctx, this.catalog());
        return { kind: 'ok', command: 'CREATE TABLE' };
      case 'dropTable':
        executeDropTable(b, ctx, this.catalog());
        return { kind: 'ok', command: 'DROP TABLE' };
      case 'createIndex':
        executeCreateIndex(b, ctx, this.catalog());
        return { kind: 'ok', command: 'CREATE INDEX' };
      case 'dropIndex':
        executeDropIndex(b, ctx, this.catalog());
        return { kind: 'ok', command: 'DROP INDEX' };
      case 'begin':
      case 'commit':
      case 'rollback':
        throw new InternalError('INVARIANT_VIOLATION', 'transaction statements are handled before binding');
      default:
        return assertNever(b, 'bound statement');
    }
  }

  /** Schema introspection for tools (CLI .tables/.schema/.indexes). Tables and indexes sorted by name. */
  schema(): TableInfo[] {
    return this.guard(() => {
      this.pager.ensureUsable();
      return this.catalog()
        .tables()
        .map((t) => ({
          name: t.name,
          columns: t.columns.map((c) => ({ name: c.name, type: c.type, notNull: c.notNull, primaryKey: c.primaryKey })),
          indexes: t.indexes.map((i) => ({ name: i.name, column: i.column, unique: i.unique, auto: i.auto })),
        }));
    });
  }

  checkpoint(): void {
    this.guard(() => this.pager.checkpoint());
  }

  integrityCheck(): IntegrityReport {
    return this.guard(() => {
      this.pager.ensureUsable();
      if (this.pager.inTxn()) throw new TransactionError('TXN_ACTIVE', 'integrityCheck is not allowed inside a transaction');
      this.catalogCache = null;
      return checkIntegrity(this.pager, this.pager.stats().wal.frames);
    });
  }

  stats(): DbStats {
    return this.pager.stats();
  }

  resetStats(): void {
    this.pager.resetStats();
  }

  /** DC-60: rolls back an open transaction, checkpoints, releases the lock. Idempotent. */
  close(): void {
    this.catalogCache = null;
    this.guard(() => this.pager.close());
  }
}
