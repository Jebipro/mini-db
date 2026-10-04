import { describe, expect, it } from 'vitest';
import { checkSqlCrashCase, sqlCrashCases, traceOfSql, workloads, type SqlWorkload } from '../support/sql-crash.js';

function opString(w: SqlWorkload): string {
  return traceOfSql(w)
    .map((o) => {
      const wal = o.file.endsWith('-wal');
      if (o.kind === 'write') return wal ? 'W' : 'w';
      if (o.kind === 'sync') return wal ? 'S' : 's';
      if (o.kind === 'truncate') return wal ? 'T' : 't';
      return 'D';
    })
    .join('');
}

describe('SQL-level crash (short)', () => {
  const all = workloads();
  const byName = (n: string): SqlWorkload => all.find((w) => w.name === n) as SqlWorkload;

  it('T-CRASH-001 CW2 at every op under P-DURABLE and P-TORN(512)', () => {
    const w = byName('CW2');
    const cases = sqlCrashCases(traceOfSql(w), false);
    expect(cases.length).toBeGreaterThan(40);
    for (const c of cases) checkSqlCrashCase(w, c);
  });

  it('T-CRASH-004 SQL workloads follow the write/fsync protocol (commits W+S, checkpoints w+ s T S W S)', () => {
    for (const w of all) {
      const s = opString(w);
      expect(s, w.name).toMatch(/^D?TSWS(W+S|w+sTSWS)*$/);
      expect(s.replace(/w+sTSWS/g, ''), w.name).not.toMatch(/[ws]/);
    }
  });

  it('T-CRASH-003 the checkpoint workload contains every checkpoint step and each is a crash point', () => {
    const w = byName('CW5');
    const trace = traceOfSql(w);
    const s = trace.map((o) => (o.kind === 'write' ? (o.file.endsWith('-wal') ? 'W' : 'w') : o.kind === 'sync' ? (o.file.endsWith('-wal') ? 'S' : 's') : o.kind === 'truncate' ? 'T' : 'D')).join('');
    const checkpoints = [...s.matchAll(/w+sTSWS/g)];
    expect(checkpoints.length).toBeGreaterThanOrEqual(4); // bootstrap, 2 explicit, auto (threshold 4), close
    // crash at each step of one mid-workload checkpoint: data write, F5, truncate, F2, header write, F3
    const m = checkpoints[2] as RegExpMatchArray;
    const start = (m.index as number) + 1; // op numbers are 1-based
    const steps = m[0].length;
    for (let k = 0; k < steps; k++) {
      for (const spec of [{ policy: 'durable-only' as const, label: 'P-DURABLE' }, { policy: 'all-pending' as const, label: 'P-ALL' }]) {
        checkSqlCrashCase(w, { op: start + k, spec });
      }
    }
  });
});
