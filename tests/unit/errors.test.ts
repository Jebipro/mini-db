import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../../src/errors/codes.js';
import * as E from '../../src/errors/errors.js';

const classes = {
  SqlSyntaxError: E.SqlSyntaxError,
  SemanticError: E.SemanticError,
  ConstraintError: E.ConstraintError,
  TransactionError: E.TransactionError,
  LimitError: E.LimitError,
  StorageError: E.StorageError,
  CorruptionError: E.CorruptionError,
  InternalError: E.InternalError,
  UsageError: E.UsageError,
} as const;

describe('errors', () => {
  it('T-ERR-001 every class extends MiniDbError, names match, codes are well formed and equal the H.2 table', () => {
    for (const [name, Cls] of Object.entries(classes)) {
      const codes = ERROR_CODES[name as keyof typeof ERROR_CODES];
      expect(codes.length).toBeGreaterThan(0);
      for (const code of codes) {
        expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
        // the constructor accepts only the class's own codes at the type level
        const err = new (Cls as new (c: string, m: string) => E.MiniDbError)(code, 'm');
        expect(err).toBeInstanceOf(E.MiniDbError);
        expect(err).toBeInstanceOf(Error);
        expect(err.name).toBe(name);
        expect(err.code).toBe(code);
        expect(E.isMiniDbError(err)).toBe(true);
      }
    }
    const all = Object.values(ERROR_CODES).flat();
    expect(new Set(all).size).toBe(all.length);

    // codes.ts == SPEC.md H.2 (pairs of class and code)
    const spec = readFileSync(new URL('../../SPEC.md', import.meta.url), 'utf8');
    const rows = [...spec.matchAll(/^\| ([A-Za-z]+Error) \| `([A-Z][A-Z0-9_]*)` \|/gm)].map((m) => `${m[1]}:${m[2]}`);
    const fromCode = Object.entries(ERROR_CODES).flatMap(([k, v]) => v.map((c) => `${k}:${c}`));
    expect(new Set(rows)).toEqual(new Set(fromCode));
  });

  it('T-ERR-002 format(): position, source line and caret', () => {
    const source = 'SELECT * FROM t WHERE (a, b)';
    const err = new E.SqlSyntaxError('SYNTAX_UNEXPECTED_TOKEN', "expected ')' but found ','", {
      position: { offset: 24, line: 1, column: 25 },
      source,
    });
    expect(err.format()).toBe(
      [
        "SqlSyntaxError SYNTAX_UNEXPECTED_TOKEN at 1:25: expected ')' but found ','",
        '  1 | SELECT * FROM t WHERE (a, b)',
        '    |                         ^',
      ].join('\n'),
    );
  });

  it('T-ERR-002 format(): tabs and multi-byte characters before the column', () => {
    const source = "x\n\t'한😀' ?";
    // line 2: tab(1) '(2) 한(3) 😀(4) '(5) space(6) ?(7)
    const err = new E.SqlSyntaxError('SYNTAX_INVALID_CHARACTER', "unexpected character '?'", {
      position: { offset: 9, line: 2, column: 7 },
      source,
    });
    expect(err.sourceLine).toBe("\t'한😀' ?");
    expect(err.format().split('\n')[2]).toBe('    | \t     ^');
  });

  it('T-ERR-002 format(): no position, statement index suffix, CRLF source', () => {
    const e1 = new E.StorageError('DB_LOCKED', 'database is locked');
    expect(e1.format()).toBe('StorageError DB_LOCKED: database is locked');
    e1.statementIndex = 2;
    expect(e1.format()).toBe('StorageError DB_LOCKED: database is locked (statement 3)');

    const e2 = new E.SemanticError('TABLE_NOT_FOUND', 'no such table: t', {
      position: { offset: 16, line: 2, column: 6 },
      source: 'BEGIN;\r\nSELECT * FROM t',
    });
    expect(e2.sourceLine).toBe('SELECT * FROM t');
    e2.statementIndex = 1;
    expect(e2.format().split('\n')[0]).toBe('SemanticError TABLE_NOT_FOUND at 2:6: no such table: t (statement 2)');
  });

  it('T-ERR-001 cause is preserved', () => {
    const inner = new E.StorageError('IO_COMMIT_UNKNOWN', 'x');
    const outer = new E.StorageError('DB_FAILED', 'failed', { cause: inner });
    expect(outer.cause).toBe(inner);
  });
});
