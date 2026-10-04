import { describe, expect, it } from 'vitest';
import { LimitError, MiniDbError, SqlSyntaxError } from '../../src/errors/errors.js';
import { tokenize } from '../../src/sql/lexer.js';

function err(sql: string): MiniDbError {
  try {
    tokenize(sql);
  } catch (e) {
    if (e instanceof MiniDbError) return e;
    throw e;
  }
  throw new Error(`no error for ${sql}`);
}

const brief = (sql: string): string[] => tokenize(sql).map((t) => `${t.kind}:${t.text}`);

describe('lexer', () => {
  it('T-LEX-001 token kinds and positions with \\n, \\r\\n, tabs and multi-byte text', () => {
    expect(brief("SELECT a, 'x' FROM t WHERE n >= 10;")).toEqual([
      'KEYWORD:SELECT', 'IDENT:a', 'PUNCT:,', "STRING:'x'", 'KEYWORD:FROM', 'IDENT:t', 'KEYWORD:WHERE', 'IDENT:n', 'PUNCT:>=', 'INTEGER:10', 'PUNCT:;', 'EOF:',
    ]);
    const toks = tokenize("a\r\n\tb '한😀' c\nd");
    expect(toks.map((t) => [t.pos.line, t.pos.column, t.pos.offset])).toEqual([
      [1, 1, 0],
      [2, 2, 4],
      [2, 4, 6],
      [2, 9, 12],
      [3, 1, 14],
      [3, 2, 15],
    ]);
    expect(brief('<><=>=!=<>=')).toEqual(['PUNCT:<>', 'PUNCT:<=', 'PUNCT:>=', 'PUNCT:!=', 'PUNCT:<>', 'PUNCT:=', 'EOF:']);
  });

  it("T-LEX-002 '' escapes, newlines inside strings, unterminated strings report the opening quote", () => {
    const [s] = tokenize("'it''s\nok'");
    expect(s).toMatchObject({ kind: 'STRING', value: "it's\nok" });
    const [e] = tokenize("''");
    expect(e).toMatchObject({ kind: 'STRING', value: '' });
    const u = err("SELECT 'abc");
    expect(u).toBeInstanceOf(SqlSyntaxError);
    expect(u.code).toBe('SYNTAX_UNTERMINATED_STRING');
    expect(u.position).toEqual({ offset: 7, line: 1, column: 8 });
    expect(err("x\n  'a''").position).toEqual({ offset: 4, line: 2, column: 3 });
  });

  it('T-LEX-003 comments, case-insensitive keywords, lower-cased identifiers, 64/65-byte identifiers', () => {
    expect(brief('select -- comment ; here\nFoo_Bar FrOm x--tail')).toEqual(['KEYWORD:SELECT', 'IDENT:foo_bar', 'KEYWORD:FROM', 'IDENT:x', 'EOF:']);
    expect(brief('5--3')).toEqual(['INTEGER:5', 'EOF:']);
    expect(brief('- -3')).toEqual(['PUNCT:-', 'PUNCT:-', 'INTEGER:3', 'EOF:']);
    expect(tokenize('a'.repeat(64))[0]).toMatchObject({ kind: 'IDENT' });
    const long = err(`SELECT ${'b'.repeat(65)}`);
    expect(long).toBeInstanceOf(LimitError);
    expect(long.code).toBe('IDENTIFIER_TOO_LONG');
    expect(long.position?.column).toBe(8);
  });

  it('T-LEX-004 integer literal range and invalid numbers', () => {
    expect(tokenize('9007199254740991')[0]).toMatchObject({ kind: 'INTEGER', value: 9007199254740991 });
    expect(tokenize('007')[0]).toMatchObject({ kind: 'INTEGER', value: 7 });
    const big = err('9007199254740992');
    expect(big).toBeInstanceOf(LimitError);
    expect(big.code).toBe('INTEGER_OUT_OF_RANGE');
    expect(err('99999999999999999999999').code).toBe('INTEGER_OUT_OF_RANGE');
    const bad = err('SELECT 123abc');
    expect(bad.code).toBe('SYNTAX_INVALID_NUMBER');
    expect(bad.position?.column).toBe(8);
  });

  it('T-LEX-005 lone surrogates, 4000/4001-byte strings and invalid characters', () => {
    expect(err("'\uD800'").code).toBe('SYNTAX_INVALID_STRING');
    expect(err("'a\uDC00b'").code).toBe('SYNTAX_INVALID_STRING');
    expect(tokenize(`'${'x'.repeat(4000)}'`)[0]).toMatchObject({ kind: 'STRING' });
    expect(err(`'${'x'.repeat(4001)}'`).code).toBe('TEXT_TOO_LARGE');
    // 1334 × '한' = 4002 bytes although only 1334 characters
    expect(err(`'${'한'.repeat(1334)}'`).code).toBe('TEXT_TOO_LARGE');
    expect(tokenize(`'${'한'.repeat(1333)}'`)[0]).toMatchObject({ kind: 'STRING' });
    for (const ch of ['!', '?', '.', '"', '@', '#', '😀']) {
      const e = err(`a ${ch}`);
      expect(e.code, ch).toBe('SYNTAX_INVALID_CHARACTER');
      expect(e.position?.column).toBe(3);
    }
  });
});
