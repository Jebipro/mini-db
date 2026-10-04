import { describe, expect, it } from 'vitest';
import type { TableSchema } from '../../src/catalog/schema.js';
import { LimitError, MiniDbError } from '../../src/errors/errors.js';
import { compareNullable, evaluate } from '../../src/exec/eval.js';
import type { Value } from '../../src/record/value.js';
import { analyze } from '../../src/sql/analyzer.js';
import type { BExpr, SchemaLookup } from '../../src/sql/bound.js';
import { parseStatement } from '../../src/sql/parser.js';

const t: TableSchema = {
  name: 't',
  heapHead: 2,
  indexes: [],
  columns: [
    { name: 'a', type: 'BOOLEAN', notNull: false, primaryKey: false, position: 0 },
    { name: 'b', type: 'BOOLEAN', notNull: false, primaryKey: false, position: 1 },
    { name: 'n', type: 'INTEGER', notNull: false, primaryKey: false, position: 2 },
    { name: 's', type: 'TEXT', notNull: false, primaryKey: false, position: 3 },
  ],
};
const lookup: SchemaLookup = { getTable: (n) => (n === 't' ? t : undefined), getIndex: () => undefined, objectExists: (n) => n === 't' };

/** Binds `expr` as a WHERE condition (or any expression via `x IS NULL` wrapping avoided) of table t. */
function boundExpr(expr: string): { e: BExpr; src: string } {
  const src = `UPDATE t SET n = n WHERE ${expr}`;
  const b = analyze(parseStatement(src), lookup, src);
  if (b.kind !== 'update' || !b.where) throw new Error('bad bind');
  return { e: b.where, src };
}

function boundValue(expr: string): { e: BExpr; src: string } {
  const src = `UPDATE t SET n = ${expr}`;
  const b = analyze(parseStatement(src), lookup, src);
  if (b.kind !== 'update') throw new Error('bad bind');
  return { e: (b.assignments[0] as { value: BExpr }).value, src };
}

const run = (x: { e: BExpr; src: string }, row: Value[] = [null, null, null, null]): Value => evaluate(x.e, row, { source: x.src });

const TV: Array<[string, Value]> = [
  ['TRUE', true],
  ['FALSE', false],
  ['NULL', null],
];

describe('evaluator', () => {
  it('T-EVAL-001 AND / OR / NOT truth tables over {TRUE, FALSE, UNKNOWN}', () => {
    const and = (x: Value, y: Value): Value => (x === false || y === false ? false : x === null || y === null ? null : true);
    const or = (x: Value, y: Value): Value => (x === true || y === true ? true : x === null || y === null ? null : false);
    for (const [xs, x] of TV) {
      for (const [ys, y] of TV) {
        expect(run(boundExpr(`${xs} AND ${ys}`)), `${xs} AND ${ys}`).toBe(and(x, y));
        expect(run(boundExpr(`${xs} OR ${ys}`)), `${xs} OR ${ys}`).toBe(or(x, y));
        // through columns as well
        expect(run(boundExpr('a AND b'), [x, y, null, null])).toBe(and(x, y));
        expect(run(boundExpr('a OR b'), [x, y, null, null])).toBe(or(x, y));
      }
      expect(run(boundExpr(`NOT ${xs}`))).toBe(x === null ? null : !x);
    }
  });

  it('T-EVAL-002 NULL propagates through comparison and arithmetic; IS NULL is never NULL', () => {
    for (const op of ['=', '<>', '<', '<=', '>', '>=']) {
      expect(run(boundExpr(`NULL ${op} NULL`))).toBeNull();
      expect(run(boundExpr(`n ${op} 1`), [null, null, null, null])).toBeNull();
      expect(run(boundExpr(`s ${op} 'x'`), [null, null, null, null])).toBeNull();
    }
    expect(run(boundValue('n + 1'))).toBeNull();
    expect(run(boundValue('- n'))).toBeNull();
    expect(run(boundValue('NULL * 3'))).toBeNull();
    expect(run(boundExpr('n IS NULL'))).toBe(true);
    expect(run(boundExpr('n IS NOT NULL'))).toBe(false);
    expect(run(boundExpr('NULL IS NULL'))).toBe(true);
    expect(run(boundExpr('(NULL = 1) IS NULL'))).toBe(true);
    expect(run(boundExpr('n = 3'), [null, null, 3, null])).toBe(true);
    expect(run(boundExpr('TRUE > FALSE'))).toBe(true);
  });

  it('T-EVAL-003 integer overflow at the safe-integer boundaries', () => {
    const MAX = Number.MAX_SAFE_INTEGER;
    expect(run(boundValue(`${MAX - 1} + 1`))).toBe(MAX);
    expect(run(boundValue(`-${MAX} + 0`))).toBe(-MAX);
    expect(run(boundValue(`- ${MAX}`))).toBe(-MAX);
    expect(run(boundValue('0 * -5'))).toBe(0);
    expect(Object.is(run(boundValue('0 * -5')), -0)).toBe(false);
    const cases = [`${MAX} + 1`, `-${MAX} - 1`, `${MAX} * 2`, `94906267 * 94906267`, `-${MAX} * -1 * 2`, `n * n`];
    for (const c of cases) {
      let caught: unknown;
      try {
        run(boundValue(c), [null, null, MAX, null]);
      } catch (e) {
        caught = e;
      }
      expect(caught, c).toBeInstanceOf(LimitError);
      expect((caught as MiniDbError).code).toBe('INTEGER_OVERFLOW');
      expect((caught as MiniDbError).position, c).toBeDefined();
    }
    // the position is the operator of the overflowing operation
    try {
      run(boundValue(`1 + ${MAX} * 9`));
    } catch (e) {
      expect((e as MiniDbError).position?.column).toBe('UPDATE t SET n = 1 + 9007199254740991 '.length + 1);
    }
  });

  it('T-EVAL-004 TEXT ordering is UTF-8 byte order, not UTF-16 code units', () => {
    const lt = (a: string, b: string): Value => run(boundExpr(`'${a}' < '${b}'`));
    expect(lt('ｱ', '😀')).toBe(true); // U+FF71 < U+1F600 (JS '<' says the opposite)
    expect('ｱ' < '😀').toBe(false);
    expect(lt('B', 'a')).toBe(true);
    expect(lt('', 'a')).toBe(true);
    expect(lt('a', 'ab')).toBe(true);
    expect(lt('é', 'z')).toBe(false);
    expect(compareNullable(null, 'a')).toBe(-1);
    expect(compareNullable(null, null)).toBe(0);
    expect(compareNullable(false, true)).toBe(-1);
  });

  it('T-EVAL-005 AND/OR short-circuit: the right side is not evaluated after FALSE AND / TRUE OR', () => {
    const MAX = Number.MAX_SAFE_INTEGER;
    expect(run(boundExpr(`FALSE AND ${MAX} * 2 > 0`))).toBe(false);
    expect(run(boundExpr(`TRUE OR ${MAX} * 2 > 0`))).toBe(true);
    expect(() => run(boundExpr(`TRUE AND ${MAX} * 2 > 0`))).toThrow(LimitError);
    expect(() => run(boundExpr(`NULL AND ${MAX} * 2 > 0`))).toThrow(LimitError);
    expect(() => run(boundExpr(`FALSE OR ${MAX} * 2 > 0`))).toThrow(LimitError);
  });
});
