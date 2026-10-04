import { describe, expect, it } from 'vitest';
import { LimitError, MiniDbError, SqlSyntaxError } from '../../src/errors/errors.js';
import { parseExpression, parseScript, parseStatement } from '../../src/sql/parser.js';
import { printExpr, printStatement } from '../../src/sql/printer.js';
import { createRng, type Rng } from '../../src/util/prng.js';

function err(fn: () => unknown): MiniDbError {
  try {
    fn();
  } catch (e) {
    if (e instanceof MiniDbError) return e;
    throw e;
  }
  throw new Error('expected an error');
}

/** AST without positions, for structural comparison. */
function shape(x: unknown): unknown {
  return JSON.parse(JSON.stringify(x, (k, v) => (k === 'pos' ? undefined : v)));
}

const POSITIVE = [
  'SELECT * FROM t',
  'select a, b, a from T',
  'SELECT a FROM t WHERE a = 1 AND b <> 2 OR NOT c',
  'SELECT a FROM t ORDER BY a, b DESC, c ASC',
  'SELECT a FROM t LIMIT 0',
  'SELECT a FROM t WHERE a IS NOT NULL ORDER BY a LIMIT 10 OFFSET 5',
  'EXPLAIN SELECT * FROM t WHERE x >= -3',
  'INSERT INTO t VALUES (1)',
  "INSERT INTO t (a, b) VALUES (1, 'x'), (-2, NULL), (3 * 4, TRUE)",
  'UPDATE t SET a = a + 1',
  'UPDATE t SET a = 1, b = FALSE WHERE c IS NULL',
  'DELETE FROM t',
  'DELETE FROM t WHERE a < 3',
  'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL, ok BOOLEAN)',
  'CREATE TABLE t (a INTEGER NOT NULL PRIMARY KEY)',
  'DROP TABLE t',
  'CREATE INDEX i ON t (a)',
  'CREATE UNIQUE INDEX i ON t (a)',
  'DROP INDEX i',
  'BEGIN',
  'COMMIT;',
  'ROLLBACK ;',
];

const NEGATIVE: Array<[string, string, number]> = [
  // sql, code, column
  ['SELECT FROM t', 'SYNTAX_UNEXPECTED_TOKEN', 8],
  ['SELECT * t', 'SYNTAX_UNEXPECTED_TOKEN', 10],
  ['SELECT * FROM', 'SYNTAX_UNEXPECTED_EOF', 14],
  ['SELECT * FROM t LIMIT -1', 'SYNTAX_UNEXPECTED_TOKEN', 23],
  ['SELECT * FROM t OFFSET 1', 'SYNTAX_UNEXPECTED_TOKEN', 17],
  ['SELECT * FROM t ORDER a', 'SYNTAX_UNEXPECTED_TOKEN', 23],
  ['SELECT 1 FROM t', 'SYNTAX_UNEXPECTED_TOKEN', 8],
  ['SELECT a AS b FROM t', 'SYNTAX_UNEXPECTED_TOKEN', 10],
  ['SELECT * FROM t WHERE', 'SYNTAX_UNEXPECTED_EOF', 22],
  ['INSERT INTO t VALUES ()', 'SYNTAX_UNEXPECTED_TOKEN', 23],
  ['INSERT t VALUES (1)', 'SYNTAX_UNEXPECTED_TOKEN', 8],
  ['UPDATE t a = 1', 'SYNTAX_UNEXPECTED_TOKEN', 10],
  ['DELETE t', 'SYNTAX_UNEXPECTED_TOKEN', 8],
  ['CREATE TABLE t ()', 'SYNTAX_UNEXPECTED_TOKEN', 17],
  ['CREATE TABLE t (a REAL)', 'SYNTAX_UNEXPECTED_TOKEN', 19],
  ['CREATE TABLE t (a INTEGER NOT)', 'SYNTAX_UNEXPECTED_TOKEN', 30],
  ['CREATE INDEX i t (a)', 'SYNTAX_UNEXPECTED_TOKEN', 16],
  ['CREATE UNIQUE TABLE t (a INTEGER)', 'SYNTAX_UNEXPECTED_TOKEN', 15],
  ['DROP VIEW v', 'SYNTAX_UNEXPECTED_TOKEN', 6],
  ['EXPLAIN DELETE FROM t', 'SYNTAX_UNEXPECTED_TOKEN', 9],
  ['BEGIN TRANSACTION', 'SYNTAX_UNEXPECTED_TOKEN', 7],
  ['SELECT * FROM t; x', 'SYNTAX_UNEXPECTED_TOKEN', 18],
  ['t', 'SYNTAX_UNEXPECTED_TOKEN', 1],
];

describe('parser', () => {
  it('T-PAR-001 grammar: positive and negative cases for every production', () => {
    for (const sql of POSITIVE) {
      const [stmt] = parseScript(sql);
      expect(stmt, sql).toBeDefined();
    }
    for (const [sql, code, column] of NEGATIVE) {
      const e = err(() => parseScript(sql));
      expect(e, sql).toBeInstanceOf(SqlSyntaxError);
      expect([e.code, e.position?.column], sql).toEqual([code, column]);
    }
    expect(parseScript(';; SELECT * FROM a ;; SELECT * FROM b ;').map((s) => s.kind)).toEqual(['select', 'select']);
    expect(parseScript('-- only a comment')).toEqual([]);
    expect(shape(parseStatement("INSERT INTO t (a) VALUES (1), ('x')"))).toEqual({
      kind: 'insert',
      table: { name: 't' },
      columns: [{ name: 'a' }],
      rows: [{ values: [{ kind: 'int', value: 1 }] }, { values: [{ kind: 'str', value: 'x' }] }],
    });
    expect(shape(parseStatement('CREATE TABLE t (id INTEGER NOT NULL PRIMARY KEY)'))).toEqual({
      kind: 'createTable',
      name: { name: 't' },
      columns: [{ name: { name: 'id' }, type: 'INTEGER', constraints: [{ kind: 'notNull' }, { kind: 'primaryKey' }] }],
    });
  });

  it('T-PAR-002 operator precedence and associativity (F.3)', () => {
    const cases: Array<[string, string]> = [
      ['1 + 2 * 3', '(1 + (2 * 3))'],
      ['1 - 2 - 3', '((1 - 2) - 3)'],
      ['2 * 3 * 4', '((2 * 3) * 4)'],
      ['-a * b', '((-a) * b)'],
      ['- -5', '(-(-5))'],
      ['a + 1 = b * 2', '((a + 1) = (b * 2))'],
      ['NOT a = b', '(NOT (a = b))'],
      ['NOT NOT a', '(NOT (NOT a))'],
      ['a OR b AND c', '(a OR (b AND c))'],
      ['a AND b OR c AND d', '((a AND b) OR (c AND d))'],
      ['a OR b OR c', '((a OR b) OR c)'],
      ['a + 1 IS NULL', '((a + 1) IS NULL)'],
      ['a IS NOT NULL AND b', '((a IS NOT NULL) AND b)'],
      ['NOT a IS NULL', '(NOT (a IS NULL))'],
      ['(a OR b) AND c', '((a OR b) AND c)'],
      ['a != b', '(a <> b)'],
      ['x * (y + z)', '(x * (y + z))'],
      ["'it''s' = s", "('it''s' = s)"],
      ['TRUE AND FALSE OR NULL', '((TRUE AND FALSE) OR NULL)'],
    ];
    for (const [src, want] of cases) expect(printExpr(parseExpression(src)), src).toBe(want);
  });

  it('T-PAR-003 comparisons are non-associative', () => {
    for (const [src, column] of [
      ['a = b = c', 7],
      ['a < b > c', 7],
      ['a = b IS NULL', 7],
      ['a IS NULL = b', 11],
      ['a IS NULL IS NULL', 11],
    ] as const) {
      const e = err(() => parseExpression(src));
      expect([e.code, e.position?.column], src).toEqual(['SYNTAX_UNEXPECTED_TOKEN', column]);
    }
  });

  it('T-PAR-004 error messages name the expected token and the exact position', () => {
    const e = err(() => parseStatement('SELECT * FROM t WHERE (a, b)'));
    expect(e.message).toBe("expected ')' but found ','");
    expect(e.format()).toBe(
      ["SqlSyntaxError SYNTAX_UNEXPECTED_TOKEN at 1:25: expected ')' but found ','", '  1 | SELECT * FROM t WHERE (a, b)', '    |                         ^'].join('\n'),
    );
    const eof = err(() => parseStatement('SELECT * FROM'));
    expect([eof.code, eof.message]).toEqual(['SYNTAX_UNEXPECTED_EOF', 'expected table name but found end of input']);
    const multi = err(() => parseStatement('BEGIN;\n  COMMIT'));
    expect([multi.code, multi.position?.line, multi.position?.column]).toEqual(['SYNTAX_MULTIPLE_STATEMENTS', 2, 3]);
    const empty = err(() => parseStatement('  ; -- nothing'));
    expect(empty.code).toBe('SYNTAX_EMPTY_STATEMENT');
    const kw = err(() => parseStatement('SELECT select FROM t'));
    expect(kw.message).toBe('expected column name or * but found SELECT');
  });

  it('T-PAR-005 fuzzing: mutated SQL either parses or fails with a SQL error, never anything else', () => {
    const r = createRng(2024);
    const alphabet = ["'", '(', ')', ',', ';', '-', '*', '=', '<', '>', '!', ' ', 'a', '1', 'SELECT', 'NOT', 'NULL', '\n', '"', '😀', '\uD800'];
    for (let i = 0; i < 3000; i++) {
      let s = r.pick(POSITIVE);
      const edits = r.nextInt(1, 4);
      for (let k = 0; k < edits; k++) {
        const at = r.nextInt(0, s.length);
        const op = r.nextInt(0, 3);
        if (op === 0) s = s.slice(0, at) + s.slice(Math.min(s.length, at + r.nextInt(1, 6)));
        else if (op === 1) s = s.slice(0, at) + r.pick(alphabet) + s.slice(at);
        else if (op === 2) s = s.slice(0, at) + s.slice(at, at + r.nextInt(1, 10)) + s.slice(at);
        else s = s.slice(at) + s.slice(0, at);
      }
      try {
        parseScript(s);
      } catch (e) {
        if (!(e instanceof SqlSyntaxError || e instanceof LimitError)) {
          throw new Error(`unexpected ${String(e)} for input ${JSON.stringify(s)}`);
        }
        expect(e.position, s).toBeDefined();
      }
    }
  });

  it('T-PAR-006 statements generated from the EBNF parse, and printing round-trips to the same AST', () => {
    const r = createRng(77);
    for (let i = 0; i < 1500; i++) {
      const sql = genStatement(r);
      let stmt;
      try {
        stmt = parseStatement(sql);
      } catch (e) {
        throw new Error(`generated statement rejected: ${sql}\n${(e as MiniDbError).format?.() ?? String(e)}`);
      }
      const printed = printStatement(stmt);
      expect(shape(parseStatement(printed)), `${sql}\n→ ${printed}`).toEqual(shape(stmt));
    }
  });
});

// ------------------------------------------------------------------ test-owned EBNF generator (F.2)

function kw(r: Rng, word: string): string {
  const v = r.nextInt(0, 2);
  return v === 0 ? word : v === 1 ? word.toLowerCase() : word[0] + word.slice(1).toLowerCase();
}
function ident(r: Rng): string {
  return r.pick(['a', 'b', 'c', 'id', 'name', 'x_1', '_t', 'Col', 'tbl']);
}
function genPrimary(r: Rng, depth: number): string {
  const x = r.nextInt(0, 9);
  if (x <= 2) return String(r.pick([0, 1, 42, 9007199254740991, 7]));
  if (x === 3) return `'${r.pick(['', 'x', "it''s", '한', '😀', 'a b'])}'`;
  if (x === 4) return kw(r, r.pick(['TRUE', 'FALSE', 'NULL']));
  if (x <= 7 || depth > 3) return ident(r);
  return `(${genExpr(r, depth + 1)})`;
}
function genUnary(r: Rng, depth: number): string {
  return r.chance(0.15) ? `- ${genUnary(r, depth + 1)}` : genPrimary(r, depth); // '--' would start a comment
}
function genMul(r: Rng, depth: number): string {
  let s = genUnary(r, depth);
  while (r.chance(0.2)) s += ` * ${genUnary(r, depth)}`;
  return s;
}
function genAdd(r: Rng, depth: number): string {
  let s = genMul(r, depth);
  while (r.chance(0.25)) s += ` ${r.pick(['+', '-'])} ${genMul(r, depth)}`;
  return s;
}
function genCmp(r: Rng, depth: number): string {
  const left = genAdd(r, depth);
  const x = r.nextFloat();
  if (x < 0.4) return `${left} ${r.pick(['=', '<>', '!=', '<', '<=', '>', '>='])} ${genAdd(r, depth)}`;
  if (x < 0.5) return `${left} ${kw(r, 'IS')} ${r.chance(0.5) ? `${kw(r, 'NOT')} ` : ''}${kw(r, 'NULL')}`;
  return left;
}
function genNot(r: Rng, depth: number): string {
  return r.chance(0.15) ? `${kw(r, 'NOT')} ${genNot(r, depth + 1)}` : genCmp(r, depth);
}
function genAnd(r: Rng, depth: number): string {
  let s = genNot(r, depth);
  while (r.chance(0.25)) s += ` ${kw(r, 'AND')} ${genNot(r, depth)}`;
  return s;
}
function genExpr(r: Rng, depth = 0): string {
  let s = genAnd(r, depth);
  while (r.chance(0.2)) s += ` ${kw(r, 'OR')} ${genAnd(r, depth)}`;
  return s;
}
function list<T>(r: Rng, n: number, f: () => T): T[] {
  return Array.from({ length: r.nextInt(1, n) }, f);
}
function genSelect(r: Rng): string {
  let s = `${kw(r, 'SELECT')} ${r.chance(0.3) ? '*' : list(r, 3, () => ident(r)).join(', ')} ${kw(r, 'FROM')} ${ident(r)}`;
  if (r.chance(0.6)) s += ` ${kw(r, 'WHERE')} ${genExpr(r)}`;
  if (r.chance(0.4)) s += ` ${kw(r, 'ORDER')} ${kw(r, 'BY')} ${list(r, 3, () => `${ident(r)}${r.pick(['', ` ${kw(r, 'ASC')}`, ` ${kw(r, 'DESC')}`])}`).join(', ')}`;
  if (r.chance(0.4)) s += ` ${kw(r, 'LIMIT')} ${r.nextInt(0, 50)}${r.chance(0.5) ? ` ${kw(r, 'OFFSET')} ${r.nextInt(0, 50)}` : ''}`;
  return s;
}
function genStatement(r: Rng): string {
  const x = r.nextInt(0, 11);
  const body = (() => {
    switch (x) {
      case 0:
      case 1:
        return genSelect(r);
      case 2:
        return `${kw(r, 'EXPLAIN')} ${genSelect(r)}`;
      case 3: {
        const n = r.nextInt(1, 3);
        const cols = r.chance(0.5) ? ` (${Array.from({ length: n }, () => ident(r)).join(', ')})` : '';
        const rows = list(r, 3, () => `(${Array.from({ length: n }, () => genExpr(r)).join(', ')})`);
        return `${kw(r, 'INSERT')} ${kw(r, 'INTO')} ${ident(r)}${cols} ${kw(r, 'VALUES')} ${rows.join(', ')}`;
      }
      case 4:
        return `${kw(r, 'UPDATE')} ${ident(r)} ${kw(r, 'SET')} ${list(r, 3, () => `${ident(r)} = ${genExpr(r)}`).join(', ')}${r.chance(0.6) ? ` ${kw(r, 'WHERE')} ${genExpr(r)}` : ''}`;
      case 5:
        return `${kw(r, 'DELETE')} ${kw(r, 'FROM')} ${ident(r)}${r.chance(0.6) ? ` ${kw(r, 'WHERE')} ${genExpr(r)}` : ''}`;
      case 6: {
        const cols = list(r, 4, () => {
          const cons = Array.from({ length: r.nextInt(0, 2) }, () => (r.chance(0.5) ? `${kw(r, 'NOT')} ${kw(r, 'NULL')}` : `${kw(r, 'PRIMARY')} ${kw(r, 'KEY')}`));
          return [ident(r), kw(r, r.pick(['INTEGER', 'TEXT', 'BOOLEAN'])), ...cons].join(' ');
        });
        return `${kw(r, 'CREATE')} ${kw(r, 'TABLE')} ${ident(r)} (${cols.join(', ')})`;
      }
      case 7:
        return `${kw(r, 'DROP')} ${kw(r, 'TABLE')} ${ident(r)}`;
      case 8:
        return `${kw(r, 'CREATE')} ${r.chance(0.5) ? `${kw(r, 'UNIQUE')} ` : ''}${kw(r, 'INDEX')} ${ident(r)} ${kw(r, 'ON')} ${ident(r)} (${ident(r)})`;
      case 9:
        return `${kw(r, 'DROP')} ${kw(r, 'INDEX')} ${ident(r)}`;
      default:
        return kw(r, r.pick(['BEGIN', 'COMMIT', 'ROLLBACK']));
    }
  })();
  return r.chance(0.3) ? `${body};` : body;
}
