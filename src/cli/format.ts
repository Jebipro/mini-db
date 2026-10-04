import type { ExecResult, Value } from '../index.js';

/** CLI / golden output format (F.12). Deterministic, no alignment. */
export function formatValue(v: Value): string {
  if (v === null) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

export function formatResult(r: ExecResult): string {
  switch (r.kind) {
    case 'rows': {
      const lines = [r.columns.join(' | '), ...r.rows.map((row) => row.map(formatValue).join(' | '))];
      lines.push(r.rows.length === 1 ? '(1 row)' : `(${r.rows.length} rows)`);
      return lines.join('\n');
    }
    case 'changes':
      return `${r.command} ${r.changes}`;
    case 'ok':
      return r.command;
  }
}
