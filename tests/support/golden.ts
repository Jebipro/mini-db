import { formatResult } from '../../src/cli/format.js';
import { Database } from '../../src/engine/database.js';
import { MiniDbError } from '../../src/errors/errors.js';
import { MemoryVfs } from '../../src/storage/memory-vfs.js';
import { deterministicEntropy } from './db.js';

/**
 * Test-owned statement splitter: ';' outside string literals and '--' comments. Unlike the engine's
 * script parser it keeps going after a syntax error, so golden files can show many errors.
 */
export function splitStatements(script: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  while (i < script.length) {
    const c = script[i] as string;
    if (c === "'") {
      const j = script.indexOf("'", i + 1);
      // '' escapes are two adjacent literals as far as splitting is concerned
      const end = j < 0 ? script.length : j + 1;
      cur += script.slice(i, end);
      i = end;
    } else if (c === '-' && script[i + 1] === '-') {
      const j = script.indexOf('\n', i);
      const end = j < 0 ? script.length : j;
      cur += script.slice(i, end);
      i = end;
    } else if (c === ';') {
      out.push(cur);
      cur = '';
      i++;
    } else {
      cur += c;
      i++;
    }
  }
  out.push(cur);
  return out
    .map((s) => s.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n').trim())
    .filter((s) => s.length > 0);
}

/** Runs a golden script: each statement echoed with '> ', followed by its result or ERROR line. */
export function runGolden(script: string): string {
  const db = Database.open('golden.db', { vfs: new MemoryVfs(), entropy: deterministicEntropy(1) });
  const out: string[] = [];
  try {
    for (const stmt of splitStatements(script.replace(/\r\n/g, '\n'))) {
      out.push(`> ${stmt.replace(/\n/g, '\n  ')}`);
      try {
        out.push(formatResult(db.execute(stmt)));
      } catch (e) {
        if (!(e instanceof MiniDbError)) throw e;
        out.push(`ERROR ${e.format().split('\n')[0]}`);
      }
      out.push('');
    }
    const report = db.integrityCheck();
    out.push(`-- integrity: ${report.ok ? 'ok' : report.issues.map((i) => i.code).join(', ')}`);
  } finally {
    db.close();
  }
  return `${out.join('\n')}\n`;
}
