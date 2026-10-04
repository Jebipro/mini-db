import type { SourcePosition } from '../errors/errors.js';

/** Reserved keywords (F.1). */
export const KEYWORDS = [
  'AND', 'ASC', 'BEGIN', 'BOOLEAN', 'BY', 'COMMIT', 'CREATE', 'DELETE', 'DESC', 'DROP', 'EXPLAIN', 'FALSE',
  'FROM', 'INDEX', 'INSERT', 'INTEGER', 'INTO', 'IS', 'KEY', 'LIMIT', 'NOT', 'NULL', 'OFFSET', 'ON', 'OR',
  'ORDER', 'PRIMARY', 'ROLLBACK', 'SELECT', 'SET', 'TABLE', 'TEXT', 'TRUE', 'UNIQUE', 'UPDATE', 'VALUES', 'WHERE',
] as const;
export type Keyword = (typeof KEYWORDS)[number];
export const KEYWORD_SET: ReadonlySet<string> = new Set(KEYWORDS);

export const PUNCTUATION = ['(', ')', ',', ';', '*', '+', '-', '=', '<>', '!=', '<', '<=', '>', '>='] as const;
export type Punct = (typeof PUNCTUATION)[number];

export type Token =
  | { kind: 'KEYWORD'; text: Keyword; pos: SourcePosition }
  | { kind: 'IDENT'; text: string; pos: SourcePosition }
  | { kind: 'INTEGER'; text: string; value: number; pos: SourcePosition }
  | { kind: 'STRING'; text: string; value: string; pos: SourcePosition }
  | { kind: 'PUNCT'; text: Punct; pos: SourcePosition }
  | { kind: 'EOF'; text: ''; pos: SourcePosition };

export type TokenKind = Token['kind'];

/** Human-readable token description for error messages. */
export function describeToken(t: Token): string {
  switch (t.kind) {
    case 'KEYWORD':
      return t.text;
    case 'IDENT':
      return `identifier '${t.text}'`;
    case 'INTEGER':
      return `integer ${t.text}`;
    case 'STRING':
      return 'string literal';
    case 'PUNCT':
      return `'${t.text}'`;
    case 'EOF':
      return 'end of input';
  }
}
