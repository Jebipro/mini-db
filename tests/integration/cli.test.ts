import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, statementComplete, type CliIo } from '../../src/cli/cli.js';
import { useTmpDir } from '../support/tmp.js';

const tmp = useTmpDir();

async function* lines(...ls: string[]): AsyncIterable<string> {
  for (const l of ls) yield l;
}

function io(stdin: AsyncIterable<string> = lines()): CliIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { stdin, out, err, stdout: (s) => out.push(s), stderr: (s) => err.push(s), readFile: (p) => readFileSync(p, 'utf8') };
}

describe('cli', () => {
  it('T-CLI-001 -c output format and exit codes 0/1/2/3', async () => {
    const db = join(tmp(), 'a.db');
    let x = io();
    expect(await runCli([db, '-c', "CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT, b BOOLEAN); INSERT INTO t VALUES (1, 'x', TRUE), (2, NULL, FALSE); SELECT * FROM t ORDER BY id; SELECT id FROM t WHERE id = 2; UPDATE t SET s = 'y'"], x)).toBe(0);
    expect(x.out).toEqual(['CREATE TABLE', 'INSERT 2', 'id | s | b\n1 | x | TRUE\n2 | NULL | FALSE\n(2 rows)', 'id\n2\n(1 row)', 'UPDATE 2']);
    expect(x.err).toEqual([]);

    x = io();
    expect(await runCli([db, '-c', 'INSERT INTO t VALUES (3, NULL, NULL); INSERT INTO t VALUES (1, NULL, NULL); INSERT INTO t VALUES (4, NULL, NULL)'], x)).toBe(1);
    expect(x.out).toEqual(['INSERT 1']);
    expect(x.err[0]?.split('\n')[0]).toBe('ConstraintError UNIQUE_VIOLATION at 1:60: duplicate key 1 in index mdb_pk_t (column id) (statement 2)');

    for (const bad of [[], ['-c'], [db, '-c', 'x', '-f', 'y'], [db, db], [db, '--weird']]) {
      x = io();
      expect(await runCli(bad, x), JSON.stringify(bad)).toBe(2);
      expect(x.err[0]).toMatch(/^usage: minidb/);
    }
    x = io();
    expect(await runCli(['--help'], x)).toBe(0);

    const garbage = join(tmp(), 'garbage.db');
    writeFileSync(garbage, 'this is not a database'.repeat(400));
    x = io();
    expect(await runCli([garbage, '-c', 'SELECT 1'], x)).toBe(3);
    expect(x.err[0]).toMatch(/^CorruptionError NOT_A_DATABASE/);
  });

  it('T-CLI-002 REPL: multi-line statements, semicolons inside strings, dot commands, .quit', async () => {
    const db = join(tmp(), 'r.db');
    const x = io(
      lines(
        'CREATE TABLE users (id INTEGER PRIMARY KEY,',
        "  name TEXT NOT NULL); INSERT INTO users VALUES (1, 'semi;colon');",
        "INSERT INTO users VALUES (2, 'it''s'); -- trailing comment",
        'SELECT name FROM users',
        '  ORDER BY id;',
        '.tables',
        '.schema',
        '.indexes users',
        '.integrity',
        '.checkpoint',
        '.nope',
        'SELECT * FROM missing;',
        '.quit',
        'SELECT 1;',
      ),
    );
    expect(await runCli([db], x)).toBe(0);
    expect(x.out).toEqual([
      'CREATE TABLE',
      'INSERT 1',
      'INSERT 1',
      "name\nsemi;colon\nit's\n(2 rows)",
      'users',
      'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
      'mdb_pk_users',
      'ok',
      'OK',
    ]);
    expect(x.err).toEqual(['Error: unknown command .nope', expect.stringMatching(/^SemanticError TABLE_NOT_FOUND at 1:15/)]);
    expect(statementComplete("SELECT ';'")).toBe(false);
    expect(statementComplete("SELECT ';';  -- done")).toBe(true);
    expect(statementComplete('SELECT 1 -- ;')).toBe(false);
  });

  it('T-CLI-003 -f runs a script file, stops at the first error with exit 1', async () => {
    const dir = tmp();
    const db = join(dir, 'f.db');
    const script = join(dir, 's.sql');
    writeFileSync(script, 'CREATE TABLE t (a INTEGER);\r\nINSERT INTO t VALUES (1);\r\nSELEC oops;\r\nINSERT INTO t VALUES (2);\r\n');
    const x = io();
    expect(await runCli([db, '-f', script], x)).toBe(1);
    expect(x.out).toEqual(['CREATE TABLE', 'INSERT 1']);
    expect(x.err[0]?.split('\n')[0]).toBe("SqlSyntaxError SYNTAX_UNEXPECTED_TOKEN at 3:1: expected a statement but found identifier 'selec' (statement 3)");
    const y = io();
    expect(await runCli([db, '-c', 'SELECT a FROM t'], y)).toBe(0);
    expect(y.out).toEqual(['a\n1\n(1 row)']);
    const z = io();
    expect(await runCli([db, '-f', join(dir, 'missing.sql')], z)).toBe(2);
  });
});
