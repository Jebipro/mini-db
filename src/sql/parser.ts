import { SqlSyntaxError } from '../errors/errors.js';
import type { ColumnType } from '../record/value.js';
import type {
  Assignment,
  BinaryOp,
  ColumnConstraint,
  ColumnDef,
  CreateIndexStmt,
  CreateTableStmt,
  DeleteStmt,
  Expr,
  Ident,
  InsertStmt,
  IntLiteral,
  OrderItem,
  SelectStmt,
  Statement,
  UpdateStmt,
  ValueRow,
} from './ast.js';
import { tokenize } from './lexer.js';
import { describeToken, type Keyword, type Punct, type Token } from './tokens.js';

/** Recursive-descent parser with precedence climbing for expressions (F.2, F.3). */
class Parser {
  private i = 0;
  constructor(
    private readonly src: string,
    private readonly toks: Token[],
  ) {}

  private peek(k = 0): Token {
    return this.toks[Math.min(this.i + k, this.toks.length - 1)] as Token;
  }
  private next(): Token {
    const t = this.peek();
    if (t.kind !== 'EOF') this.i++;
    return t;
  }
  private isKw(kw: Keyword, k = 0): boolean {
    const t = this.peek(k);
    return t.kind === 'KEYWORD' && t.text === kw;
  }
  private isPunct(p: Punct, k = 0): boolean {
    const t = this.peek(k);
    return t.kind === 'PUNCT' && t.text === p;
  }
  private fail(expected: string, t: Token = this.peek()): never {
    const code = t.kind === 'EOF' ? 'SYNTAX_UNEXPECTED_EOF' : 'SYNTAX_UNEXPECTED_TOKEN';
    throw new SqlSyntaxError(code, `expected ${expected} but found ${describeToken(t)}`, { position: t.pos, source: this.src });
  }
  private expectKw(kw: Keyword): Token {
    if (!this.isKw(kw)) this.fail(kw);
    return this.next();
  }
  private expectPunct(p: Punct): Token {
    if (!this.isPunct(p)) this.fail(`'${p}'`);
    return this.next();
  }
  private ident(what = 'identifier'): Ident {
    const t = this.peek();
    if (t.kind !== 'IDENT') this.fail(what);
    this.next();
    return { name: t.text, pos: t.pos };
  }
  private intLiteral(): IntLiteral {
    const t = this.peek();
    if (t.kind !== 'INTEGER') this.fail('integer literal');
    this.next();
    return { value: t.value, pos: t.pos };
  }
  private commaList<T>(item: () => T): T[] {
    const out = [item()];
    while (this.isPunct(',')) {
      this.next();
      out.push(item());
    }
    return out;
  }

  expectEnd(): void {
    if (this.peek().kind !== 'EOF') this.fail('end of input');
  }

  /** One step of script(): skips empty statements; returns the statement and its source range. */
  nextScriptStatement(): { stmt: Statement; start: number; end: number } | null {
    while (this.isPunct(';')) this.next();
    if (this.peek().kind === 'EOF') return null;
    const start = this.peek().pos.offset;
    const stmt = this.statement();
    const t = this.peek();
    if (t.kind !== 'EOF' && !this.isPunct(';')) this.fail("';' or end of input");
    return { stmt, start, end: t.pos.offset };
  }

  /** script = [statement] {";" [statement]} */
  script(): Statement[] {
    const out: Statement[] = [];
    for (;;) {
      if (this.peek().kind === 'EOF') return out;
      if (this.isPunct(';')) {
        this.next();
        continue;
      }
      out.push(this.statement());
      const t = this.peek();
      if (t.kind === 'EOF') return out;
      if (!this.isPunct(';')) this.fail("';' or end of input");
    }
  }

  statement(): Statement {
    const t = this.peek();
    if (t.kind !== 'KEYWORD') this.fail('a statement');
    switch (t.text) {
      case 'SELECT':
        return this.select();
      case 'EXPLAIN': {
        this.next();
        if (!this.isKw('SELECT')) this.fail('SELECT');
        return { kind: 'explain', select: this.select(), pos: t.pos };
      }
      case 'INSERT':
        return this.insert();
      case 'UPDATE':
        return this.update();
      case 'DELETE':
        return this.delete();
      case 'CREATE':
        return this.isKw('TABLE', 1) ? this.createTable() : this.createIndex();
      case 'DROP': {
        this.next();
        if (this.isKw('TABLE')) {
          this.next();
          return { kind: 'dropTable', name: this.ident('table name'), pos: t.pos };
        }
        if (this.isKw('INDEX')) {
          this.next();
          return { kind: 'dropIndex', name: this.ident('index name'), pos: t.pos };
        }
        return this.fail('TABLE or INDEX');
      }
      case 'BEGIN':
        this.next();
        return { kind: 'begin', pos: t.pos };
      case 'COMMIT':
        this.next();
        return { kind: 'commit', pos: t.pos };
      case 'ROLLBACK':
        this.next();
        return { kind: 'rollback', pos: t.pos };
      default:
        return this.fail('a statement');
    }
  }

  private select(): SelectStmt {
    const pos = this.expectKw('SELECT').pos;
    let columns: Ident[] | null;
    if (this.isPunct('*')) {
      this.next();
      columns = null;
    } else {
      columns = this.commaList(() => this.ident('column name or *'));
    }
    this.expectKw('FROM');
    const table = this.ident('table name');
    let where: Expr | null = null;
    if (this.isKw('WHERE')) {
      this.next();
      where = this.expr();
    }
    const orderBy: OrderItem[] = [];
    if (this.isKw('ORDER')) {
      this.next();
      this.expectKw('BY');
      orderBy.push(
        ...this.commaList(() => {
          const column = this.ident('column name');
          let desc = false;
          if (this.isKw('ASC')) this.next();
          else if (this.isKw('DESC')) {
            this.next();
            desc = true;
          }
          return { column, desc };
        }),
      );
    }
    let limit: IntLiteral | null = null;
    let offset: IntLiteral | null = null;
    if (this.isKw('LIMIT')) {
      this.next();
      limit = this.intLiteral();
      if (this.isKw('OFFSET')) {
        this.next();
        offset = this.intLiteral();
      }
    }
    return { kind: 'select', columns, table, where, orderBy, limit, offset, pos };
  }

  private insert(): InsertStmt {
    const pos = this.expectKw('INSERT').pos;
    this.expectKw('INTO');
    const table = this.ident('table name');
    let columns: Ident[] | null = null;
    if (this.isPunct('(')) {
      this.next();
      columns = this.commaList(() => this.ident('column name'));
      this.expectPunct(')');
    }
    this.expectKw('VALUES');
    const rows = this.commaList((): ValueRow => {
      const p = this.expectPunct('(').pos;
      const values = this.commaList(() => this.expr());
      this.expectPunct(')');
      return { values, pos: p };
    });
    return { kind: 'insert', table, columns, rows, pos };
  }

  private update(): UpdateStmt {
    const pos = this.expectKw('UPDATE').pos;
    const table = this.ident('table name');
    this.expectKw('SET');
    const assignments = this.commaList((): Assignment => {
      const column = this.ident('column name');
      this.expectPunct('=');
      return { column, value: this.expr() };
    });
    let where: Expr | null = null;
    if (this.isKw('WHERE')) {
      this.next();
      where = this.expr();
    }
    return { kind: 'update', table, assignments, where, pos };
  }

  private delete(): DeleteStmt {
    const pos = this.expectKw('DELETE').pos;
    this.expectKw('FROM');
    const table = this.ident('table name');
    let where: Expr | null = null;
    if (this.isKw('WHERE')) {
      this.next();
      where = this.expr();
    }
    return { kind: 'delete', table, where, pos };
  }

  private createTable(): CreateTableStmt {
    const pos = this.expectKw('CREATE').pos;
    this.expectKw('TABLE');
    const name = this.ident('table name');
    this.expectPunct('(');
    const columns = this.commaList((): ColumnDef => {
      const colName = this.ident('column name');
      const t = this.peek();
      let type: ColumnType;
      if (t.kind === 'KEYWORD' && (t.text === 'INTEGER' || t.text === 'TEXT' || t.text === 'BOOLEAN')) {
        this.next();
        type = t.text;
      } else {
        return this.fail('a column type (INTEGER, TEXT or BOOLEAN)');
      }
      const constraints: ColumnConstraint[] = [];
      for (;;) {
        if (this.isKw('NOT')) {
          const p = this.next().pos;
          this.expectKw('NULL');
          constraints.push({ kind: 'notNull', pos: p });
        } else if (this.isKw('PRIMARY')) {
          const p = this.next().pos;
          this.expectKw('KEY');
          constraints.push({ kind: 'primaryKey', pos: p });
        } else break;
      }
      return { name: colName, type, constraints };
    });
    this.expectPunct(')');
    return { kind: 'createTable', name, columns, pos };
  }

  private createIndex(): CreateIndexStmt {
    const pos = this.expectKw('CREATE').pos;
    let unique = false;
    if (this.isKw('UNIQUE')) {
      this.next();
      unique = true;
    }
    if (!this.isKw('INDEX')) this.fail(unique ? 'INDEX' : 'TABLE, INDEX or UNIQUE');
    this.next();
    const name = this.ident('index name');
    this.expectKw('ON');
    const table = this.ident('table name');
    this.expectPunct('(');
    const column = this.ident('column name');
    this.expectPunct(')');
    return { kind: 'createIndex', unique, name, table, column, pos };
  }

  // ---------------------------------------------------------------- expressions (F.3)

  expr(): Expr {
    return this.orExpr();
  }

  private orExpr(): Expr {
    let left = this.andExpr();
    while (this.isKw('OR')) {
      const pos = this.next().pos;
      left = { kind: 'binary', op: 'OR', left, right: this.andExpr(), pos };
    }
    return left;
  }

  private andExpr(): Expr {
    let left = this.notExpr();
    while (this.isKw('AND')) {
      const pos = this.next().pos;
      left = { kind: 'binary', op: 'AND', left, right: this.notExpr(), pos };
    }
    return left;
  }

  private notExpr(): Expr {
    if (this.isKw('NOT')) {
      const pos = this.next().pos;
      return { kind: 'not', operand: this.notExpr(), pos };
    }
    return this.cmpExpr();
  }

  private cmpExpr(): Expr {
    const left = this.addExpr();
    const t = this.peek();
    if (t.kind === 'PUNCT' && (t.text === '=' || t.text === '<>' || t.text === '!=' || t.text === '<' || t.text === '<=' || t.text === '>' || t.text === '>=')) {
      this.next();
      const op: BinaryOp = t.text === '!=' ? '<>' : t.text;
      return { kind: 'binary', op, left, right: this.addExpr(), pos: t.pos };
    }
    if (this.isKw('IS')) {
      const pos = this.next().pos;
      let negated = false;
      if (this.isKw('NOT')) {
        this.next();
        negated = true;
      }
      this.expectKw('NULL');
      return { kind: 'isnull', operand: left, negated, pos };
    }
    return left;
  }

  private addExpr(): Expr {
    let left = this.mulExpr();
    while (this.isPunct('+') || this.isPunct('-')) {
      const t = this.next();
      left = { kind: 'binary', op: t.text as '+' | '-', left, right: this.mulExpr(), pos: t.pos };
    }
    return left;
  }

  private mulExpr(): Expr {
    let left = this.unaryExpr();
    while (this.isPunct('*')) {
      const pos = this.next().pos;
      left = { kind: 'binary', op: '*', left, right: this.unaryExpr(), pos };
    }
    return left;
  }

  private unaryExpr(): Expr {
    if (this.isPunct('-')) {
      const pos = this.next().pos;
      return { kind: 'neg', operand: this.unaryExpr(), pos };
    }
    return this.primary();
  }

  private primary(): Expr {
    const t = this.peek();
    switch (t.kind) {
      case 'INTEGER':
        this.next();
        return { kind: 'int', value: t.value, pos: t.pos };
      case 'STRING':
        this.next();
        return { kind: 'str', value: t.value, pos: t.pos };
      case 'IDENT':
        this.next();
        return { kind: 'column', name: t.text, pos: t.pos };
      case 'KEYWORD':
        if (t.text === 'TRUE' || t.text === 'FALSE') {
          this.next();
          return { kind: 'bool', value: t.text === 'TRUE', pos: t.pos };
        }
        if (t.text === 'NULL') {
          this.next();
          return { kind: 'null', pos: t.pos };
        }
        return this.fail('an expression');
      case 'PUNCT':
        if (t.text === '(') {
          this.next();
          const e = this.expr();
          this.expectPunct(')');
          return e;
        }
        return this.fail('an expression');
      case 'EOF':
        return this.fail('an expression');
    }
  }
}

/** Parses a script: statements separated by ';', empty statements skipped (F.2). */
export function parseScript(sql: string): Statement[] {
  return new Parser(sql, tokenize(sql)).script();
}

/** Parses exactly one statement (optional trailing ';') — DC-59. */
export function parseStatement(sql: string): Statement {
  const toks = tokenize(sql);
  const stmts = new Parser(sql, toks).script();
  if (stmts.length === 0) {
    const eof = toks[toks.length - 1] as Token;
    throw new SqlSyntaxError('SYNTAX_EMPTY_STATEMENT', 'no statement to execute', { position: eof.pos, source: sql });
  }
  if (stmts.length > 1) {
    const second = stmts[1] as Statement;
    throw new SqlSyntaxError('SYNTAX_MULTIPLE_STATEMENTS', 'execute() accepts exactly one statement; use executeScript()', {
      position: second.pos,
      source: sql,
    });
  }
  return stmts[0] as Statement;
}

/** Parses a standalone expression (tests). */
export function parseExpression(sql: string): Expr {
  const toks = tokenize(sql);
  const p = new Parser(sql, toks);
  const e = p.expr();
  p.expectEnd();
  return e;
}

export interface ScriptStatement {
  stmt: Statement;
  /** Source slice of the statement (without the terminating ';'). */
  text: string;
  start: number;
}

/**
 * Incremental script parsing for executeScript (DC-59): statements are parsed one at a time so earlier
 * statements run even if a later one has a syntax error. Lexical errors reject the whole script up front.
 */
export class ScriptParser {
  private readonly toks: Token[];
  private readonly parser: Parser;
  private k = 0;

  constructor(private readonly sql: string) {
    this.toks = tokenize(sql);
    this.parser = new Parser(sql, this.toks);
  }

  /** Next non-empty statement, or null at end of input. */
  next(): ScriptStatement | null {
    const r = this.parser.nextScriptStatement();
    if (r === null) return null;
    this.k++;
    return { stmt: r.stmt, text: this.sql.slice(r.start, r.end).trim(), start: r.start };
  }

  /** Number of statements returned so far. */
  get count(): number {
    return this.k;
  }
}
