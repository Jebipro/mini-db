import { LimitError, SqlSyntaxError, type SourcePosition } from '../errors/errors.js';
import { MAX_IDENTIFIER_BYTES, MAX_SAFE, MAX_TEXT_BYTES } from '../util/limits.js';
import { hasLoneSurrogate, utf8Length } from '../util/utf8.js';
import { KEYWORD_SET, type Keyword, type Token } from './tokens.js';

/**
 * Lexer (F.1). Positions: offset = UTF-16 index, line/column 1-based, column counts code points,
 * only '\n' starts a new line ('\r' is whitespace).
 */
export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const here = (): SourcePosition => ({ offset: i, line, column: col });
  /** Advances over one code point. */
  const advance = (): void => {
    const c = src.charCodeAt(i);
    if (c === 10) {
      line++;
      col = 1;
      i++;
      return;
    }
    const pair = c >= 0xd800 && c <= 0xdbff && i + 1 < src.length && src.charCodeAt(i + 1) >= 0xdc00 && src.charCodeAt(i + 1) <= 0xdfff;
    i += pair ? 2 : 1;
    col++;
  };
  const isIdentStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isIdentPart = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  const isDigit = (c: string): boolean => c >= '0' && c <= '9';

  while (i < src.length) {
    const c = src[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      advance();
      continue;
    }
    if (c === '-' && src[i + 1] === '-') {
      while (i < src.length && src[i] !== '\n') advance();
      continue;
    }
    const pos = here();
    if (isIdentStart(c)) {
      const start = i;
      while (i < src.length && isIdentPart(src[i] as string)) advance();
      const word = src.slice(start, i);
      const upper = word.toUpperCase();
      if (KEYWORD_SET.has(upper)) {
        tokens.push({ kind: 'KEYWORD', text: upper as Keyword, pos });
      } else {
        if (word.length > MAX_IDENTIFIER_BYTES) {
          throw new LimitError('IDENTIFIER_TOO_LONG', `identifier is ${word.length} bytes (max ${MAX_IDENTIFIER_BYTES})`, { position: pos, source: src });
        }
        tokens.push({ kind: 'IDENT', text: word.toLowerCase(), pos });
      }
      continue;
    }
    if (isDigit(c)) {
      const start = i;
      while (i < src.length && isDigit(src[i] as string)) advance();
      if (i < src.length && isIdentStart(src[i] as string)) {
        throw new SqlSyntaxError('SYNTAX_INVALID_NUMBER', `invalid number '${src.slice(start, i + 1)}'`, { position: pos, source: src });
      }
      const text = src.slice(start, i);
      if (BigInt(text) > BigInt(MAX_SAFE)) {
        throw new LimitError('INTEGER_OUT_OF_RANGE', `integer literal ${text} is outside ±${MAX_SAFE}`, { position: pos, source: src });
      }
      tokens.push({ kind: 'INTEGER', text, value: Number(text), pos });
      continue;
    }
    if (c === "'") {
      advance();
      let value = '';
      let closed = false;
      while (i < src.length) {
        if (src[i] === "'") {
          if (src[i + 1] === "'") {
            value += "'";
            advance();
            advance();
            continue;
          }
          advance();
          closed = true;
          break;
        }
        const start = i;
        advance();
        value += src.slice(start, i);
      }
      if (!closed) throw new SqlSyntaxError('SYNTAX_UNTERMINATED_STRING', 'unterminated string literal', { position: pos, source: src });
      if (hasLoneSurrogate(value)) {
        throw new SqlSyntaxError('SYNTAX_INVALID_STRING', 'string literal contains an unpaired surrogate', { position: pos, source: src });
      }
      const bytes = utf8Length(value);
      if (bytes > MAX_TEXT_BYTES) {
        throw new LimitError('TEXT_TOO_LARGE', `string literal is ${bytes} bytes (max ${MAX_TEXT_BYTES})`, { position: pos, source: src });
      }
      tokens.push({ kind: 'STRING', text: src.slice(pos.offset, i), value, pos });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '<>' || two === '!=' || two === '<=' || two === '>=') {
      advance();
      advance();
      tokens.push({ kind: 'PUNCT', text: two, pos });
      continue;
    }
    if ('(),;*+-=<>'.includes(c)) {
      advance();
      tokens.push({ kind: 'PUNCT', text: c as '(' | ')' | ',' | ';' | '*' | '+' | '-' | '=' | '<' | '>', pos });
      continue;
    }
    const cp = String.fromCodePoint(src.codePointAt(i) as number);
    throw new SqlSyntaxError('SYNTAX_INVALID_CHARACTER', `unexpected character '${cp}'`, { position: pos, source: src });
  }
  tokens.push({ kind: 'EOF', text: '', pos: here() });
  return tokens;
}
