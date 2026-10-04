import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

interface ImportInfo {
  spec: string;
  typeOnly: boolean;
}

function importsOf(file: string): ImportInfo[] {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const out: ImportInfo[] = [];
  for (const st of sf.statements) {
    if ((ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      const typeOnly = ts.isImportDeclaration(st) ? (st.importClause?.isTypeOnly ?? false) : st.isTypeOnly;
      out.push({ spec: st.moduleSpecifier.text, typeOnly });
    }
  }
  return out;
}

/** Module of a src file: first directory under src/, or 'index' for src/index.ts. */
function moduleOf(file: string): string {
  const rel = relative(join(root, 'src'), file).split(sep);
  return rel.length === 1 ? 'index' : (rel[0] as string);
}

// E.2 allowed import table. 'type' = `import type` only.
const ALLOWED: Record<string, Record<string, 'yes' | 'type'>> = {
  util: {},
  errors: { util: 'yes' },
  storage: { util: 'yes', errors: 'yes' },
  record: { util: 'yes', errors: 'yes', storage: 'yes' },
  btree: { util: 'yes', errors: 'yes', storage: 'yes', record: 'yes' },
  catalog: { util: 'yes', errors: 'yes', storage: 'yes', record: 'yes' },
  sql: { util: 'yes', errors: 'yes', record: 'type', catalog: 'type' },
  exec: { util: 'yes', errors: 'yes', storage: 'yes', record: 'yes', btree: 'yes', catalog: 'yes', sql: 'yes' },
  engine: { util: 'yes', errors: 'yes', storage: 'yes', record: 'yes', btree: 'yes', catalog: 'yes', sql: 'yes', exec: 'yes' },
  cli: { errors: 'yes', index: 'yes' },
  index: { util: 'yes', errors: 'yes', storage: 'yes', record: 'yes', btree: 'yes', catalog: 'yes', sql: 'yes', exec: 'yes', engine: 'yes' },
};

const NODE_BUILTIN_OWNERS: Record<string, string[]> = {
  'node:fs': ['storage/node-vfs.ts', 'cli/main.ts'],
  'node:crypto': ['engine/database.ts'],
  'node:child_process': [],
};

describe('architecture', () => {
  it('T-ARCH-001 src import graph follows the allowed dependency table', () => {
    const violations: string[] = [];
    for (const file of walk(join(root, 'src'))) {
      const from = moduleOf(file);
      const relFile = relative(join(root, 'src'), file).split(sep).join('/');
      for (const imp of importsOf(file)) {
        if (imp.spec.startsWith('.')) {
          const target = resolve(dirname(file), imp.spec.replace(/\.js$/, '.ts'));
          const to = moduleOf(target);
          if (to === from) continue;
          const rule = ALLOWED[from]?.[to];
          if (rule === undefined) violations.push(`${relFile}: ${from} -> ${to}`);
          else if (rule === 'type' && !imp.typeOnly) violations.push(`${relFile}: ${from} -> ${to} must be import type`);
        } else if (imp.spec.startsWith('node:')) {
          const owners = NODE_BUILTIN_OWNERS[imp.spec];
          if (owners !== undefined && !owners.includes(relFile)) violations.push(`${relFile}: ${imp.spec} not allowed here`);
        } else {
          violations.push(`${relFile}: runtime dependency ${imp.spec} (DC-02)`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('T-ARCH-003 no platform randomness in src or tests and no wall-clock time in src', () => {
    const violations: string[] = [];
    const scan = (dir: string, wallClock: boolean): void => {
      for (const file of walk(dir)) {
        readFileSync(file, 'utf8')
          .split(/\r?\n/)
          .forEach((line, i) => {
            if (/^\s*(\*|\/\*)/.test(line)) return;
            const code = line.replace(/\/\/.*$/, '');
            // the pattern strings below are split so this file does not flag itself
            if (code.includes('Math.' + 'random')) violations.push(`${relative(root, file)}:${i + 1}`);
            if (wallClock && (code.includes('Date.' + 'now') || code.includes('new ' + 'Date'))) violations.push(`${relative(root, file)}:${i + 1}`);
          });
      }
    };
    scan(join(root, 'src'), true);
    scan(join(root, 'tests'), false);
    expect(violations).toEqual([]);
  });
});
