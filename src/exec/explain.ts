import { assertNever } from '../errors/assert.js';
import type { Value } from '../record/value.js';
import type { BExpr } from '../sql/bound.js';
import type { PlanNode } from './plan.js';

/** F.10 literal printing. */
export function printValue(v: Value): string {
  if (v === null) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return String(v);
  return `'${v.replace(/'/g, "''")}'`;
}

/** F.10 expression printing for bound expressions (same format as sql/printer.ts printExpr). */
export function printBExpr(e: BExpr): string {
  switch (e.kind) {
    case 'const':
      return printValue(e.value);
    case 'col':
      return e.name;
    case 'neg':
      return `(-${printBExpr(e.operand)})`;
    case 'not':
      return `(NOT ${printBExpr(e.operand)})`;
    case 'arith':
    case 'cmp':
    case 'logic':
      return `(${printBExpr(e.left)} ${e.op} ${printBExpr(e.right)})`;
    case 'isnull':
      return `(${printBExpr(e.operand)} IS ${e.negated ? 'NOT ' : ''}NULL)`;
    default:
      return assertNever(e, 'bound expression');
  }
}

/** EXPLAIN lines (F.10): pre-order, two spaces per depth. */
export function explainPlan(root: PlanNode): string[] {
  const lines: string[] = [];
  const visit = (n: PlanNode, depth: number, tableCols: string[]): void => {
    const pad = '  '.repeat(depth);
    switch (n.kind) {
      case 'project':
        lines.push(`${pad}Project columns=${n.columns.map((c) => tableCols[c]).join(', ')}`);
        return visit(n.child, depth + 1, tableCols);
      case 'limit':
        lines.push(`${pad}Limit limit=${n.limit} offset=${n.offset}`);
        return visit(n.child, depth + 1, tableCols);
      case 'sort':
        lines.push(`${pad}Sort keys=${n.keys.map((k) => `${tableCols[k.index]} ${k.desc ? 'DESC' : 'ASC'}`).join(', ')}`);
        return visit(n.child, depth + 1, tableCols);
      case 'filter':
        lines.push(`${pad}Filter predicate=${printBExpr(n.predicate)}`);
        return visit(n.child, depth + 1, tableCols);
      case 'seqScan':
        lines.push(`${pad}SeqScan table=${n.table.name}`);
        return;
      case 'indexScan': {
        const lo = n.lo === null ? '(-inf' : `${n.lo.inclusive ? '[' : '('}${printValue(n.lo.value)}`;
        const hi = n.hi === null ? '+inf)' : `${printValue(n.hi.value)}${n.hi.inclusive ? ']' : ')'}`;
        lines.push(`${pad}IndexScan table=${n.table.name} index=${n.index.name} column=${tableCols[n.column]} range=${lo}, ${hi}`);
        return;
      }
      default:
        return assertNever(n, 'plan node');
    }
  };
  visit(root, 0, scanTable(root).columns.map((c) => c.name));
  return lines;
}

function scanTable(n: PlanNode): { columns: Array<{ name: string }> } {
  switch (n.kind) {
    case 'seqScan':
    case 'indexScan':
      return n.table;
    case 'filter':
    case 'sort':
    case 'limit':
    case 'project':
      return scanTable(n.child);
    default:
      return assertNever(n, 'plan node');
  }
}
