import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MExpr, MVal } from '../model/ast.js';
import { evalExpr, RefModel, sortCmp } from '../model/ref-model.js';

const lit = (v: MVal): MExpr => ({ k: 'lit', v });

describe('reference model (oracle self-test)', () => {
  it('T-MODEL-004 the oracle evaluator, ordering and constraint rules match hand-written expectations', () => {
    const T = true;
    const F = false;
    const N = null;
    const and: Array<[MVal, MVal, MVal]> = [
      [T, T, T], [T, F, F], [T, N, N], [F, T, F], [F, F, F], [F, N, F], [N, T, N], [N, F, F], [N, N, N],
    ];
    const or: Array<[MVal, MVal, MVal]> = [
      [T, T, T], [T, F, T], [T, N, T], [F, T, T], [F, F, F], [F, N, N], [N, T, T], [N, F, N], [N, N, N],
    ];
    for (const [a, b, want] of and) expect(evalExpr({ k: 'logic', op: 'AND', l: lit(a), r: lit(b) }, {})).toBe(want);
    for (const [a, b, want] of or) expect(evalExpr({ k: 'logic', op: 'OR', l: lit(a), r: lit(b) }, {})).toBe(want);
    expect(evalExpr({ k: 'cmp', op: '=', l: lit(null), r: lit(null) }, {})).toBe(null);
    expect(evalExpr({ k: 'cmp', op: '<', l: lit('ｱ'), r: lit('😀') }, {})).toBe(true);
    expect(evalExpr({ k: 'cmp', op: '<', l: lit('B'), r: lit('a') }, {})).toBe(true);
    expect(() => evalExpr({ k: 'arith', op: '+', l: lit(9007199254740991), r: lit(1) }, {})).toThrow();
    expect(evalExpr({ k: 'arith', op: '*', l: lit(-3), r: lit(4) }, {})).toBe(-12);
    expect([3, null, 1, null, 2].sort(sortCmp)).toEqual([null, null, 1, 2, 3]);

    const m = new RefModel();
    m.apply({ k: 'create', table: 't', cols: [{ name: 'id', type: 'INTEGER', notNull: true, pk: true }, { name: 'v', type: 'TEXT', notNull: false, pk: false }] });
    expect(m.apply({ k: 'insert', table: 't', cols: null, rows: [[lit(1), lit('a')], [lit(2), lit('b')], [lit(3), lit('c')]] })).toMatchObject({ ok: true, changes: 3 });
    // permutation via id = id + 1 is fine (statement-level uniqueness)
    expect(m.apply({ k: 'update', table: 't', sets: [{ col: 'id', e: { k: 'arith', op: '+', l: { k: 'col', name: 'id' }, r: lit(1) } }], where: null })).toMatchObject({ ok: true, changes: 3 });
    // collision fails and leaves state unchanged
    const bad = m.apply({ k: 'update', table: 't', sets: [{ col: 'id', e: lit(2) }], where: { k: 'cmp', op: '=', l: { k: 'col', name: 'id' }, r: lit(4) } });
    expect(bad).toEqual({ ok: false, codes: new Set(['UNIQUE_VIOLATION']) });
    const all = m.apply({ k: 'select', table: 't', cols: ['id'], where: null, order: [{ col: 'id', desc: false }], limit: null, offset: null });
    expect(all).toMatchObject({ ok: true, rows: [[2], [3], [4]], totalOrder: true });
    // multi-row insert: one bad row fails the whole statement; codes cover every violation
    const ins = m.apply({ k: 'insert', table: 't', cols: null, rows: [[lit(9), lit('x')], [lit(null), lit('y')], [lit(2), lit('z')]] });
    expect(ins).toEqual({ ok: false, codes: new Set(['NOT_NULL_VIOLATION', 'UNIQUE_VIOLATION']) });
    expect(m.apply({ k: 'select', table: 't', cols: null, where: null, order: [], limit: null, offset: null })).toMatchObject({ rows: [[2, 'a'], [3, 'b'], [4, 'c']] });
    // transactions
    m.apply({ k: 'begin' });
    m.apply({ k: 'delete', table: 't', where: null });
    m.apply({ k: 'rollback' });
    expect(m.apply({ k: 'select', table: 't', cols: ['id'], where: null, order: [], limit: null, offset: null })).toMatchObject({ rows: [[2], [3], [4]] });
    expect(m.apply({ k: 'commit' })).toEqual({ ok: false, codes: new Set(['TXN_NOT_ACTIVE']) });
  });

  it('T-ARCH-002 the reference model imports nothing from src/ except the PRNG', () => {
    const dir = new URL('../model/', import.meta.url);
    const offending: string[] = [];
    for (const f of readdirSync(dir)) {
      const text = readFileSync(new URL(f, dir), 'utf8');
      for (const m of text.matchAll(/from\s+'([^']+)'/g)) {
        const spec = m[1] as string;
        if (spec.includes('/src/') && !spec.endsWith('/src/util/prng.js')) offending.push(`${f}: ${spec}`);
      }
    }
    expect(offending).toEqual([]);
  });
});
