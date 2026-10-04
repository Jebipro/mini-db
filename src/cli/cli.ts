import { Database, isMiniDbError, type TableInfo } from '../index.js';
import { formatResult } from './format.js';

/**
 * Thin CLI (F.12): `minidb <file> [-c <sql> | -f <script.sql>]`, REPL otherwise.
 * All I/O is injected so tests can drive it (T-CLI-*).
 */
export interface CliIo {
  /** REPL input lines (without newlines). */
  stdin: AsyncIterable<string>;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  readFile: (path: string) => string;
  /** Print prompts (interactive terminals only). */
  prompt?: boolean;
}

export const EXIT_OK = 0;
export const EXIT_SQL_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_OPEN_FAILED = 3;

const USAGE = [
  'usage: minidb <file> [-c <sql> | -f <script.sql>]',
  '       minidb --help',
  'Without -c/-f an interactive prompt starts; statements end with ";".',
].join('\n');

const HELP = [
  '.help               this text',
  '.tables             list tables',
  '.schema [table]     CREATE statements',
  '.indexes [table]    list indexes',
  '.stats              I/O and cache counters (JSON)',
  '.integrity          run the integrity check',
  '.checkpoint         write the WAL into the database file',
  '.quit | .exit       leave',
].join('\n');

function errorText(e: unknown): string {
  return isMiniDbError(e) ? e.format() : `Error: ${e instanceof Error ? e.message : String(e)}`;
}

export function schemaSql(tables: TableInfo[], only?: string): string[] {
  const out: string[] = [];
  for (const t of tables) {
    if (only !== undefined && t.name !== only) continue;
    const cols = t.columns.map((c) => `${c.name} ${c.type}${c.primaryKey ? ' PRIMARY KEY' : c.notNull ? ' NOT NULL' : ''}`);
    out.push(`CREATE TABLE ${t.name} (${cols.join(', ')});`);
    for (const i of t.indexes) if (!i.auto) out.push(`CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${i.name} ON ${t.name} (${i.column});`);
  }
  return out;
}

/** true when `buf` ends (ignoring whitespace and comments) with a ';' outside string literals. */
export function statementComplete(buf: string): boolean {
  let inString = false;
  let last = '';
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i] as string;
    if (inString) {
      if (c === "'") {
        if (buf[i + 1] === "'") i++;
        else inString = false;
      }
      last = 'x';
      continue;
    }
    if (c === "'") {
      inString = true;
      last = 'x';
    } else if (c === '-' && buf[i + 1] === '-') {
      const nl = buf.indexOf('\n', i);
      i = nl < 0 ? buf.length : nl;
    } else if (!/\s/.test(c)) {
      last = c;
    }
  }
  return !inString && last === ';';
}

function runScript(db: Database, sql: string, io: CliIo): boolean {
  try {
    db.executeScript(sql, (r) => io.stdout(formatResult(r)));
    return true;
  } catch (e) {
    io.stderr(errorText(e));
    return false;
  }
}

function dotCommand(db: Database, line: string, io: CliIo): 'quit' | 'continue' {
  const [cmd, arg] = line.trim().split(/\s+/, 2);
  try {
    switch (cmd) {
      case '.quit':
      case '.exit':
        return 'quit';
      case '.help':
        io.stdout(HELP);
        break;
      case '.tables':
        for (const t of db.schema()) io.stdout(t.name);
        break;
      case '.schema':
        for (const l of schemaSql(db.schema(), arg)) io.stdout(l);
        break;
      case '.indexes':
        for (const t of db.schema()) {
          if (arg !== undefined && t.name !== arg) continue;
          for (const i of t.indexes) io.stdout(i.name);
        }
        break;
      case '.stats':
        io.stdout(JSON.stringify(db.stats(), null, 2));
        break;
      case '.integrity': {
        const r = db.integrityCheck();
        if (r.ok) io.stdout('ok');
        for (const i of r.issues) io.stdout(`${i.code} page=${i.pageId ?? '-'} object=${i.object ?? '-'} ${i.message}`);
        break;
      }
      case '.checkpoint':
        db.checkpoint();
        io.stdout('OK');
        break;
      default:
        io.stderr(`Error: unknown command ${cmd}`);
    }
  } catch (e) {
    io.stderr(errorText(e));
  }
  return 'continue';
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout(USAGE);
    return EXIT_OK;
  }
  let file: string | undefined;
  let command: string | undefined;
  let script: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '-c' || a === '-f') {
      const v = argv[++i];
      if (v === undefined || command !== undefined || script !== undefined) {
        io.stderr(USAGE);
        return EXIT_USAGE;
      }
      if (a === '-c') command = v;
      else script = v;
    } else if (a.startsWith('-') || file !== undefined) {
      io.stderr(USAGE);
      return EXIT_USAGE;
    } else {
      file = a;
    }
  }
  if (file === undefined) {
    io.stderr(USAGE);
    return EXIT_USAGE;
  }

  let sql: string | undefined = command;
  if (script !== undefined) {
    try {
      sql = io.readFile(script);
    } catch (e) {
      io.stderr(`Error: cannot read ${script}: ${e instanceof Error ? e.message : String(e)}`);
      return EXIT_USAGE;
    }
  }

  let db: Database;
  try {
    db = Database.open(file);
  } catch (e) {
    io.stderr(errorText(e));
    return EXIT_OPEN_FAILED;
  }

  let code = EXIT_OK;
  try {
    if (sql !== undefined) {
      code = runScript(db, sql, io) ? EXIT_OK : EXIT_SQL_ERROR;
    } else {
      let buf = '';
      if (io.prompt) io.stdout('minidb> ');
      for await (const line of io.stdin) {
        if (buf === '' && line.trim().startsWith('.')) {
          if (dotCommand(db, line, io) === 'quit') break;
        } else {
          buf += buf === '' ? line : `\n${line}`;
          if (statementComplete(buf)) {
            runScript(db, buf, io);
            buf = '';
          }
        }
        if (io.prompt) io.stdout(buf === '' ? 'minidb> ' : '   ...> ');
      }
      if (buf.trim() !== '') runScript(db, buf, io);
    }
  } finally {
    const failed = db.state === 'failed';
    try {
      db.close();
    } catch (e) {
      io.stderr(errorText(e));
      code = EXIT_OPEN_FAILED;
    }
    if (failed) code = EXIT_OPEN_FAILED;
  }
  return code;
}
