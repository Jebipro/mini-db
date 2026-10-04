import { describe, expect, it } from 'vitest';
import type { IndexSchema, TableSchema } from '../../src/catalog/schema.js';
import { LimitError, MiniDbError, SemanticError } from '../../src/errors/errors.js';
import { analyze } from '../../src/sql/analyzer.js';
import type { SchemaLookup } from '../../src/sql/bound.js';
import { parseStatement } from '../../src/sql/parser.js';

const users: TableSchema = {
  name: 'users',
  heapHead: 2,
  columns: [
    { name: 'id', type: 'INTEGER', notNull: true, primaryKey: true, position: 0 },
    { name: 'name', type: 'TEXT', notNull: true, primaryKey: false, position: 1 },
    { name: 'ok', type: 'BOOLEAN', notNull: false, primaryKey: false, position: 2 },
  ],
  indexes: [],
};
const pkIdx: IndexSchema = { name: 'mdb_pk_users', table: 'users', column: 'id', unique: true, root: 3, auto: true };
const nameIdx: IndexSchema = { name: 'idx_name', table: 'users', column: 'name', unique: false, root: 4, auto: false };
users.indexes = [nameIdx, pkIdx];

const lookup: SchemaLookup = {
  getTable: (n) => (n === 'users' ? users : undefined),
  getIndex: (n) => [pkIdx, nameIdx].find((i) => i.name === n),
  objectExists: (n) => n === 'users' || n === 'idx_name' || n === 'mdb_pk_users',
};

function bind(sql: string): ReturnType<typeof analyze> {
  return analyze(parseStatement(sql), lookup, sql);
}

function err(sql: string): MiniDbError {
  try {
    bind(sql);
  } catch (e) {
    if (e instanceof MiniDbError) return e;
    throw e;
  }
  throw new Error(`no error for ${sql}`);
}

function expectErr(sql: string, code: string, column: number): void {
  const e = err(sql);
  expect([e.code, e.position?.column], sql).toEqual([code, column]);
}

describe('analyzer', () => {
  it('T-ANA-001 name resolution errors with positions', () => {
    expectErr('SELECT * FROM nope', 'TABLE_NOT_FOUND', 15);
    expectErr('SELECT id, nope FROM users', 'COLUMN_NOT_FOUND', 12);
    expectErr('SELECT * FROM users WHERE nope = 1', 'COLUMN_NOT_FOUND', 27);
    expectErr('SELECT * FROM users ORDER BY nope', 'COLUMN_NOT_FOUND', 30);
    expectErr('UPDATE users SET nope = 1', 'COLUMN_NOT_FOUND', 18);
    expectErr('DELETE FROM nope', 'TABLE_NOT_FOUND', 13);
    expectErr('DROP TABLE nope', 'TABLE_NOT_FOUND', 12);
    expectErr('DROP INDEX nope', 'INDEX_NOT_FOUND', 12);
    expectErr('CREATE INDEX i ON nope (a)', 'TABLE_NOT_FOUND', 19);
    expectErr('CREATE INDEX i ON users (nope)', 'COLUMN_NOT_FOUND', 26);
    expect(err('SELECT * FROM nope')).toBeInstanceOf(SemanticError);
    const ok = bind('SELECT name, id FROM users WHERE ok ORDER BY id DESC LIMIT 3 OFFSET 1');
    expect(ok).toMatchObject({ kind: 'select', columns: [1, 0], orderBy: [{ index: 0, desc: true }], limit: 3, offset: 1 });
    expect(bind('SELECT * FROM users')).toMatchObject({ columns: [0, 1, 2], limit: null, offset: 0 });
  });

  it('T-ANA-002 type rules for every operator and operand type pair', () => {
    const lit = { INTEGER: '1', TEXT: "'s'", BOOLEAN: 'TRUE', NULL: 'NULL' } as const;
    const types = Object.keys(lit) as Array<keyof typeof lit>;
    const ok = (sql: string): boolean => {
      try {
        bind(sql);
        return true;
      } catch (e) {
        if (e instanceof SemanticError && e.code === 'TYPE_MISMATCH') return false;
        throw e;
      }
    };
    // expressions are tested through UPDATE ... SET (no table-type constraint for WHERE) and WHERE
    for (const a of types) {
      for (const b of types) {
        const arith = (a === 'INTEGER' || a === 'NULL') && (b === 'INTEGER' || b === 'NULL');
        for (const op of ['+', '-', '*']) expect(ok(`SELECT * FROM users WHERE ${lit[a]} ${op} ${lit[b]} IS NULL`), `${a} ${op} ${b}`).toBe(arith);
        const comparable = a === 'NULL' || b === 'NULL' || a === b;
        for (const op of ['=', '<>', '<', '<=', '>', '>=']) expect(ok(`SELECT * FROM users WHERE ${lit[a]} ${op} ${lit[b]}`), `${a} ${op} ${b}`).toBe(comparable);
        const logical = (a === 'BOOLEAN' || a === 'NULL') && (b === 'BOOLEAN' || b === 'NULL');
        for (const op of ['AND', 'OR']) expect(ok(`SELECT * FROM users WHERE ${lit[a]} ${op} ${lit[b]}`), `${a} ${op} ${b}`).toBe(logical);
      }
      expect(ok(`SELECT * FROM users WHERE NOT ${lit[a]}`), `NOT ${a}`).toBe(a === 'BOOLEAN' || a === 'NULL');
      expect(ok(`SELECT * FROM users WHERE - ${lit[a]} IS NULL`), `- ${a}`).toBe(a === 'INTEGER' || a === 'NULL');
      expect(ok(`SELECT * FROM users WHERE ${lit[a]} IS NOT NULL`), `${a} IS NOT NULL`).toBe(true);
      expect(ok(`SELECT * FROM users WHERE ${lit[a]}`), `WHERE ${a}`).toBe(a === 'BOOLEAN' || a === 'NULL');
      for (const [col, colType] of [['id', 'INTEGER'], ['name', 'TEXT'], ['ok', 'BOOLEAN']] as const) {
        expect(ok(`UPDATE users SET ${col} = ${lit[a]}`), `SET ${colType} = ${a}`).toBe(a === colType || a === 'NULL');
        expect(ok(`INSERT INTO users (${col}) VALUES (${lit[a]})`), `INSERT ${colType} ← ${a}`).toBe(a === colType || a === 'NULL');
      }
    }
    // column operands carry their declared type; positions point at the operator
    expectErr('SELECT * FROM users WHERE id = name', 'TYPE_MISMATCH', 30);
    expectErr('SELECT * FROM users WHERE id + 1', 'TYPE_MISMATCH', 30); // binary nodes are positioned at their operator
    expectErr("UPDATE users SET id = 'x'", 'TYPE_MISMATCH', 23);
    expect(bind('UPDATE users SET id = id * 2 + 1 WHERE ok AND id > 3')).toMatchObject({ kind: 'update', assignments: [{ index: 0 }] });
  });

  it('T-ANA-003 DDL checks: names, duplicates, primary keys, column count, PK index', () => {
    expectErr('CREATE TABLE users (a INTEGER)', 'OBJECT_EXISTS', 14);
    expectErr('CREATE TABLE idx_name (a INTEGER)', 'OBJECT_EXISTS', 14);
    expectErr('CREATE INDEX users ON users (id)', 'OBJECT_EXISTS', 14);
    expectErr('CREATE TABLE mdb_x (a INTEGER)', 'RESERVED_NAME', 14);
    expectErr('CREATE INDEX mdb_i ON users (id)', 'RESERVED_NAME', 14);
    expectErr('CREATE TABLE t (a INTEGER, b TEXT, a BOOLEAN)', 'DUPLICATE_COLUMN', 36);
    expectErr('CREATE TABLE t (a INTEGER NOT NULL NOT NULL)', 'DUPLICATE_CONSTRAINT', 36);
    expectErr('CREATE TABLE t (a INTEGER PRIMARY KEY PRIMARY KEY)', 'DUPLICATE_CONSTRAINT', 39);
    expectErr('CREATE TABLE t (a INTEGER PRIMARY KEY, b INTEGER PRIMARY KEY)', 'MULTIPLE_PRIMARY_KEYS', 50);
    const cols = (n: number): string => Array.from({ length: n }, (_, i) => `c${i} INTEGER`).join(', ');
    expect(bind(`CREATE TABLE t (${cols(64)})`)).toMatchObject({ kind: 'createTable' });
    const many = err(`CREATE TABLE t (${cols(65)})`);
    expect(many).toBeInstanceOf(LimitError);
    expect(many.code).toBe('TOO_MANY_COLUMNS');
    expectErr('DROP INDEX mdb_pk_users', 'CANNOT_DROP_PK_INDEX', 12);
    expect(bind('CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT)')).toMatchObject({
      columns: [
        { name: 'id', notNull: true, primaryKey: true, position: 0 },
        { name: 's', notNull: false, primaryKey: false, position: 1 },
      ],
    });
  });

  it('T-ANA-004 INSERT checks: duplicate targets, value count, column references', () => {
    expectErr('INSERT INTO users (id, id) VALUES (1, 2)', 'DUPLICATE_COLUMN', 24);
    expectErr('UPDATE users SET id = 1, id = 2', 'DUPLICATE_COLUMN', 26);
    expectErr("INSERT INTO users VALUES (1, 'a')", 'COLUMN_COUNT_MISMATCH', 26);
    expectErr("INSERT INTO users (id) VALUES (1), (2, 'x')", 'COLUMN_COUNT_MISMATCH', 36);
    expectErr('INSERT INTO users (id) VALUES (id + 1)', 'NOT_CONSTANT', 32);
    expectErr('INSERT INTO users (id) VALUES (nope)', 'NOT_CONSTANT', 32);
    expect(bind("INSERT INTO users (name, id) VALUES ('a', 1), ('b', -2 * 3)")).toMatchObject({ kind: 'insert', targets: [1, 0] });
  });
});
