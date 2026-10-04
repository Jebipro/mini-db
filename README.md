# Mini DB

An embedded, single-file relational database engine written from scratch in TypeScript — for learning how a
database works, and for **proving with tests** that it does not lose or corrupt data on a crash.

- Disk pages (4 KiB, CRC32 per page), slotted heap pages, a self-describing catalog
- Disk B+tree indexes (unique / non-unique, single column)
- A SQL-like language: lexer → recursive-descent parser → analyzer → rule-based planner → Volcano executor
- Transactions with statement-level atomicity, redo-only page-image **WAL**, checkpoint and crash recovery
- Zero runtime dependencies (devDependencies: `typescript`, `vitest`, `@types/node`)

The design is fixed in [DESIGN_REVIEW.md](DESIGN_REVIEW.md) (rev1); deviations are recorded in
[DECISIONS.md](DECISIONS.md).

## Install and run

Requires Node.js ≥ 20.

```bash
npm install
npm run build
```

```bash
npm run cli -- my.db
```

```bash
npm run cli -- my.db -c "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO t VALUES (1, 'a'); SELECT * FROM t"
```

REPL dot commands: `.help .tables .schema .indexes .stats .integrity .checkpoint .quit`.
Exit codes: `0` ok, `1` SQL error, `2` usage error, `3` open failure / failed handle.

## Library

```ts
import { Database } from 'mini-db';

const db = Database.open('app.db');            // creates the file if needed (and app.db-wal, app.db-lock)
db.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, active BOOLEAN)');
db.execute("INSERT INTO users VALUES (1, 'alice', TRUE), (2, 'bob', FALSE)");
const r = db.execute('SELECT name FROM users WHERE active ORDER BY id');
// r = { kind: 'rows', columns: ['name'], rows: [['alice']] }

db.execute('BEGIN');
db.execute("UPDATE users SET name = 'bobby' WHERE id = 2");
db.execute('COMMIT');                          // durable once this returns (one WAL fsync)

db.executeScript('CREATE INDEX users_name ON users (name); SELECT * FROM users');
console.log(db.integrityCheck().ok, db.stats().io);
db.close();
```

Values are `number` (safe integers, ±(2^53−1)), `string`, `boolean` or `null`. Errors are `MiniDbError`
subclasses with a stable `code` and, for SQL errors, `line:column` plus the source line (`err.format()`).

## The language (summary — see [SPEC.md](SPEC.md))

- Types: `INTEGER`, `TEXT`, `BOOLEAN`, `NULL`; no implicit conversions
- `CREATE TABLE` (NOT NULL, single-column PRIMARY KEY), `DROP TABLE`, `CREATE [UNIQUE] INDEX`, `DROP INDEX`
- `INSERT` (multi-row VALUES), `SELECT cols|* FROM t [WHERE] [ORDER BY] [LIMIT n [OFFSET m]]`, `UPDATE`, `DELETE`
- Expressions: comparisons, `AND/OR/NOT` (three-valued logic), `IS [NOT] NULL`, integer `+ - *`, unary `-`
- `BEGIN / COMMIT / ROLLBACK`, `EXPLAIN SELECT …`

## Layout

```text
src/util      CRC32, PRNG, bytes, UTF-8          src/sql       lexer, parser, analyzer
src/errors    error hierarchy and codes          src/exec      evaluator, planner, operators, DML/DDL
src/storage   VFS, page format, WAL, pager       src/engine    Database API, integrity check
src/record    row codec, slotted pages, heap     src/cli       REPL and script runner
src/btree     key codec, nodes, B+tree           src/catalog   catalog heap and schema
tests/        unit, integration, golden SQL, reference model, crash/corruption suites
bench/        benchmark harness
```

Documents: [ARCHITECTURE](ARCHITECTURE.md) · [FORMAT](FORMAT.md) · [DURABILITY](DURABILITY.md) ·
[TESTING](TESTING.md) · [BENCHMARKS](BENCHMARKS.md) · [LIMITATIONS](LIMITATIONS.md) · [FUTURE](FUTURE.md) ·
[LEARNING](LEARNING.md) · [REVIEW_PACKET](REVIEW_PACKET.md) · [PROGRESS](PROGRESS.md)

Study material: [Core walkthrough](docs/study/MINI_DB_CORE_WALKTHROUGH.md) (durability, Page 0, heap, B+tree, UPDATE,
planner, testing, real findings, self-check).

## Testing

```bash
npm run check
```

`check` = typecheck + `check:any` (no explicit `any`, no `Math.random`) + `check:docs` (error codes, fsync tags,
test IDs) + `npm test` (unit, integration, SQL golden files, short model-based and crash suites).

```bash
npm run test:random
```

Model-based random testing against an independent reference model (`SEEDS`, `SEED_START`, `SEED`, `STEPS`).
A failure prints the seed and the command that reproduces it.

```bash
npm run test:crash
```

Exhaustive fault injection: every write/fsync/truncate of the page-level and SQL workloads is a crash point,
under several "what survived" policies (only synced data, everything, torn writes, random subsets), plus
crashes during recovery. After every crash the database must reopen, pass `integrityCheck`, and contain
exactly the acknowledged transactions (the in-flight one may or may not be present).

```bash
npm run bench
```

## Limitations

Single process, single connection, synchronous; rows must fit one page (4060 bytes); index keys ≤ 512 bytes;
no joins, aggregates, subqueries or ALTER TABLE; crash safety is verified against a simulated file system, not
real power loss. Full list: [LIMITATIONS.md](LIMITATIONS.md).

## Development process and AI collaboration

This project was built with extensive use of AI tools for design, implementation, testing, review and documentation. The design review, the implementation (P0–P17), the post-implementation review and the follow-up fixes were written by an AI coding agent (Claude Code). The author wrote the staged instructions (design review, implementation plan, review and fix scope), decided each next step, and checked and accepted the results. The review in [CLAUDE_INDEPENDENT_REVIEW.md](CLAUDE_INDEPENDENT_REVIEW.md) was performed by the same AI under separate instructions; it is not a human code review.

The repository keeps the design decisions ([DESIGN_REVIEW](DESIGN_REVIEW.md), [DECISIONS](DECISIONS.md)), the test evidence ([TESTING](TESTING.md)), the known limitations ([LIMITATIONS](LIMITATIONS.md)) and the verification results next to the code.

## About this public repository

This repository starts from the final validated state rather than the full development history. Seven-character commit hashes in [PROGRESS](PROGRESS.md), the review reports, [BENCHMARKS](BENCHMARKS.md) and the study material (for example `b58d809`) refer to the private development history and cannot be looked up here. The figures and conclusions are as recorded at those points; the source and tests in this repository are identical to the last development commit.

## License

MIT. See [LICENSE](LICENSE).
