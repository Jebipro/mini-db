import type { CodeOf, ErrorClassName, ErrorCode } from './codes.js';

/** 1-based source position (DC-55). Columns count Unicode code points. */
export interface SourcePosition {
  offset: number;
  line: number;
  column: number;
}

export interface ErrorDetails {
  position?: SourcePosition;
  /** Full text the position refers to; used to derive `sourceLine`. */
  source?: string;
  cause?: unknown;
}

/** Returns the text of `line` (1-based) in `source`, without the line terminator. */
export function sourceLineAt(source: string, line: number): string {
  const lines = source.split('\n');
  const text = lines[line - 1] ?? '';
  return text.endsWith('\r') ? text.slice(0, -1) : text;
}

export abstract class MiniDbError extends Error {
  readonly code: ErrorCode;
  readonly position?: SourcePosition;
  readonly sourceLine?: string;
  /** 0-based index within executeScript; formatted 1-based. */
  statementIndex?: number;

  protected constructor(name: ErrorClassName, code: ErrorCode, message: string, details: ErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = name;
    this.code = code;
    if (details.position !== undefined && details.source !== undefined) {
      this.position = details.position;
      this.sourceLine = sourceLineAt(details.source, details.position.line);
    }
  }

  /** H.3 format. */
  format(): string {
    const suffix = this.statementIndex === undefined ? '' : ` (statement ${this.statementIndex + 1})`;
    if (this.position === undefined || this.sourceLine === undefined) {
      return `${this.name} ${this.code}: ${this.message}${suffix}`;
    }
    const { line, column } = this.position;
    const lineLabel = String(line);
    const caretPad = Array.from(this.sourceLine)
      .slice(0, column - 1)
      .map((ch) => (ch === '\t' ? '\t' : ' '))
      .join('');
    return [
      `${this.name} ${this.code} at ${line}:${column}: ${this.message}${suffix}`,
      `  ${lineLabel} | ${this.sourceLine}`,
      `  ${' '.repeat(lineLabel.length)} | ${caretPad}^`,
    ].join('\n');
  }
}

export class SqlSyntaxError extends MiniDbError {
  constructor(code: CodeOf<'SqlSyntaxError'>, message: string, details?: ErrorDetails) {
    super('SqlSyntaxError', code, message, details);
  }
}
export class SemanticError extends MiniDbError {
  constructor(code: CodeOf<'SemanticError'>, message: string, details?: ErrorDetails) {
    super('SemanticError', code, message, details);
  }
}
export class ConstraintError extends MiniDbError {
  constructor(code: CodeOf<'ConstraintError'>, message: string, details?: ErrorDetails) {
    super('ConstraintError', code, message, details);
  }
}
export class TransactionError extends MiniDbError {
  constructor(code: CodeOf<'TransactionError'>, message: string, details?: ErrorDetails) {
    super('TransactionError', code, message, details);
  }
}
export class LimitError extends MiniDbError {
  constructor(code: CodeOf<'LimitError'>, message: string, details?: ErrorDetails) {
    super('LimitError', code, message, details);
  }
}
export class StorageError extends MiniDbError {
  constructor(code: CodeOf<'StorageError'>, message: string, details?: ErrorDetails) {
    super('StorageError', code, message, details);
  }
}
export class CorruptionError extends MiniDbError {
  constructor(code: CodeOf<'CorruptionError'>, message: string, details?: ErrorDetails) {
    super('CorruptionError', code, message, details);
  }
}
export class InternalError extends MiniDbError {
  constructor(code: CodeOf<'InternalError'>, message: string, details?: ErrorDetails) {
    super('InternalError', code, message, details);
  }
}
export class UsageError extends MiniDbError {
  constructor(code: CodeOf<'UsageError'>, message: string, details?: ErrorDetails) {
    super('UsageError', code, message, details);
  }
}

export function isMiniDbError(e: unknown): e is MiniDbError {
  return e instanceof MiniDbError;
}
