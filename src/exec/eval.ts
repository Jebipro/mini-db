import { assertNever } from '../errors/assert.js';
import { InternalError, LimitError } from '../errors/errors.js';
import type { Value } from '../record/value.js';
import type { BExpr, CmpOp } from '../sql/bound.js';
import { compareText } from '../util/utf8.js';

/**
 * Expression evaluation with SQL three-valued logic (F.5). NULL represents UNKNOWN.
 * AND/OR short-circuit on FALSE/TRUE left operands; arithmetic results are range-checked per operation.
 */

/** Ordering of two non-NULL values of the same type (DC-39: TEXT by UTF-8 bytes; FALSE < TRUE). */
export function compareValues(a: Exclude<Value, null>, b: Exclude<Value, null>): -1 | 0 | 1 {
  if (typeof a === 'string' && typeof b === 'string') return compareText(a, b);
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
  // the analyzer only binds comparisons of equal types (F.4), so this is a bug
  throw new InternalError('INVARIANT_VIOLATION', `incomparable values ${String(a)} and ${String(b)}`);
}

/** Sort order with NULL smallest (DC-34); DESC is applied by the caller. */
export function compareNullable(a: Value, b: Value): -1 | 0 | 1 {
  if (a === null) return b === null ? 0 : -1;
  if (b === null) return 1;
  return compareValues(a, b);
}

function cmp(op: CmpOp, c: -1 | 0 | 1): boolean {
  switch (op) {
    case '=':
      return c === 0;
    case '<>':
      return c !== 0;
    case '<':
      return c < 0;
    case '<=':
      return c <= 0;
    case '>':
      return c > 0;
    case '>=':
      return c >= 0;
  }
}

export interface EvalContext {
  /** SQL text the bound positions refer to (for runtime error positions, H.4). */
  source: string;
}

function overflow(e: BExpr, ctx: EvalContext): LimitError {
  return new LimitError('INTEGER_OVERFLOW', 'integer result out of range', { position: e.pos, source: ctx.source });
}

export function evaluate(e: BExpr, row: readonly Value[], ctx: EvalContext): Value {
  switch (e.kind) {
    case 'const':
      return e.value;
    case 'col':
      return row[e.index] as Value;
    case 'neg': {
      const v = evaluate(e.operand, row, ctx);
      if (v === null) return null;
      return v === 0 ? 0 : -(v as number);
    }
    case 'not': {
      const v = evaluate(e.operand, row, ctx);
      return v === null ? null : !(v as boolean);
    }
    case 'arith': {
      const l = evaluate(e.left, row, ctx);
      const r = evaluate(e.right, row, ctx);
      if (l === null || r === null) return null;
      const a = l as number;
      const b = r as number;
      const out = e.op === '+' ? a + b : e.op === '-' ? a - b : a * b;
      if (!Number.isSafeInteger(out)) throw overflow(e, ctx);
      return out === 0 ? 0 : out; // normalizes -0
    }
    case 'cmp': {
      const l = evaluate(e.left, row, ctx);
      const r = evaluate(e.right, row, ctx);
      if (l === null || r === null) return null;
      return cmp(e.op, compareValues(l, r));
    }
    case 'logic': {
      const l = evaluate(e.left, row, ctx);
      if (e.op === 'AND' && l === false) return false;
      if (e.op === 'OR' && l === true) return true;
      const r = evaluate(e.right, row, ctx);
      if (e.op === 'AND') {
        if (r === false) return false;
        return l === null || r === null ? null : true;
      }
      if (r === true) return true;
      return l === null || r === null ? null : false;
    }
    case 'isnull': {
      const v = evaluate(e.operand, row, ctx);
      return e.negated ? v !== null : v === null;
    }
    default:
      return assertNever(e, 'bound expression');
  }
}

/** WHERE semantics: only TRUE passes. */
export function isTrue(v: Value): boolean {
  return v === true;
}
