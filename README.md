# Mini DB

**한국어** | [English](./README.en.md)

TypeScript로 처음부터 작성한 임베디드 단일 파일 관계형 데이터베이스 엔진입니다. 데이터베이스가 내부에서 어떻게 동작하는지 배우고, crash가 나도 데이터를 잃거나 손상시키지 않는다는 것을 **테스트로 검증**하기 위해 만들었습니다.

- Disk page(4 KiB, page마다 CRC32), slotted heap page, 스스로를 기술하는 catalog
- Disk B+tree index (unique / non-unique, 단일 column)
- SQL과 비슷한 언어: lexer → recursive-descent parser → analyzer → rule-based planner → Volcano executor
- 문장 단위 원자성을 갖는 transaction, redo-only page-image **WAL**, checkpoint와 crash recovery
- runtime 의존성 없음 (devDependencies: `typescript`, `vitest`, `@types/node`)

설계는 [DESIGN_REVIEW.md](DESIGN_REVIEW.md)(rev1)에서 확정했고, 이후 달라진 결정은 [DECISIONS.md](DECISIONS.md)에 기록했습니다.

## 설치와 실행

Node.js 20 이상이 필요합니다.

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

REPL dot command: `.help .tables .schema .indexes .stats .integrity .checkpoint .quit`.
Exit code: `0` 정상, `1` SQL 오류, `2` 사용법 오류, `3` open 실패 / 실패 상태의 handle.

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

값은 `number`(safe integer, ±(2^53−1)), `string`, `boolean`, `null`입니다. 오류는 고정된 `code`를 가진 `MiniDbError` 하위 class이며, SQL 오류는 `line:column`과 해당 소스 줄(`err.format()`)도 함께 제공합니다.

## 언어 요약 ([SPEC.md](SPEC.md) 참조)

- Type: `INTEGER`, `TEXT`, `BOOLEAN`, `NULL`. 암묵적 변환 없음
- `CREATE TABLE`(NOT NULL, 단일 column PRIMARY KEY), `DROP TABLE`, `CREATE [UNIQUE] INDEX`, `DROP INDEX`
- `INSERT`(여러 row의 VALUES), `SELECT cols|* FROM t [WHERE] [ORDER BY] [LIMIT n [OFFSET m]]`, `UPDATE`, `DELETE`
- 식: 비교, `AND/OR/NOT`(3값 논리), `IS [NOT] NULL`, 정수 `+ - *`, 단항 `-`
- `BEGIN / COMMIT / ROLLBACK`, `EXPLAIN SELECT …`

## 구조

```text
src/util      CRC32, PRNG, bytes, UTF-8          src/sql       lexer, parser, analyzer
src/errors    error hierarchy and codes          src/exec      evaluator, planner, operators, DML/DDL
src/storage   VFS, page format, WAL, pager       src/engine    Database API, integrity check
src/record    row codec, slotted pages, heap     src/cli       REPL and script runner
src/btree     key codec, nodes, B+tree           src/catalog   catalog heap and schema
tests/        unit, integration, golden SQL, reference model, crash/corruption suites
bench/        benchmark harness
```

문서: [ARCHITECTURE](ARCHITECTURE.md) · [FORMAT](FORMAT.md) · [DURABILITY](DURABILITY.md) ·
[TESTING](TESTING.md) · [BENCHMARKS](BENCHMARKS.md) · [LIMITATIONS](LIMITATIONS.md) · [FUTURE](FUTURE.md) ·
[LEARNING](LEARNING.md) · [REVIEW_PACKET](REVIEW_PACKET.md) · [PROGRESS](PROGRESS.md)

학습 자료: [Core walkthrough](docs/study/MINI_DB_CORE_WALKTHROUGH.md) (durability, Page 0, heap, B+tree, UPDATE,
planner, testing, 실제 발견 사항, self-check).

## 테스트

```bash
npm run check
```

`check` = typecheck + `check:any`(명시적 `any`와 `Math.random` 금지) + `check:docs`(오류 code, fsync tag,
테스트 ID 대조) + `npm test`(unit, integration, SQL golden file, 짧은 model-based·crash suite).

```bash
npm run test:random
```

독립 참조 모델과 비교하는 model-based 무작위 테스트입니다(`SEEDS`, `SEED_START`, `SEED`, `STEPS`).
실패하면 해당 seed와 재현 명령을 출력합니다.

```bash
npm run test:crash
```

전수 fault injection입니다. page 수준과 SQL 수준 workload의 모든 write/fsync/truncate가 crash 지점이 되고,
"무엇이 남았는가"에 대한 여러 정책(동기화된 데이터만, 전부, 찢어진 write, 무작위 일부)으로 실행합니다.
recovery 도중의 crash도 포함합니다. crash 이후에는 매번 DB가 다시 열리고 `integrityCheck`를 통과해야 하며,
확인(acknowledge)된 transaction만 정확히 남아 있어야 합니다(진행 중이던 transaction은 있을 수도, 없을 수도 있습니다).

```bash
npm run bench
```

## 한계

단일 프로세스, 단일 connection, 동기 실행입니다. row는 한 page(4060바이트)에 들어가야 하고, index key는 512바이트 이하입니다.
join, aggregate, subquery, ALTER TABLE은 없습니다. crash 안전성은 실제 전원 차단(power loss)이 아니라 시뮬레이션한
파일 시스템으로 검증했습니다. 전체 목록: [LIMITATIONS.md](LIMITATIONS.md).

## 개발 과정과 AI 협업

이 프로젝트는 설계, 구현, 테스트, 리뷰, 문서화 과정에서 AI 도구를 적극적으로 활용했습니다. 설계 검토, 구현(P0–P17), 구현 후 리뷰와 후속 수정은 AI 코딩 에이전트(Claude Code)가 작성했습니다. 작성자는 단계별 지시서(설계 검토, 구현 계획, 리뷰와 수정 범위)를 쓰고, 다음 단계를 결정하고, 결과를 확인해 채택했습니다. [CLAUDE_INDEPENDENT_REVIEW.md](CLAUDE_INDEPENDENT_REVIEW.md)의 리뷰는 같은 AI가 별도 지시로 수행한 것이며, 사람의 코드 리뷰가 아닙니다.

저장소에는 설계 결정([DESIGN_REVIEW](DESIGN_REVIEW.md), [DECISIONS](DECISIONS.md)), 테스트 근거([TESTING](TESTING.md)), 알려진 한계([LIMITATIONS](LIMITATIONS.md)), 검증 결과를 코드와 함께 남겼습니다.

## 공개 저장소 안내

이 저장소는 개발 history 대신 검증을 마친 최종 상태로 시작합니다. [PROGRESS](PROGRESS.md), 리뷰 보고서, [BENCHMARKS](BENCHMARKS.md), 학습 자료에 나오는 7자리 commit hash(예: `b58d809`)는 비공개 개발 history의 commit을 가리키며, 이 저장소에서는 조회할 수 없습니다. 기록된 수치와 결론은 그 시점의 결과이고, 이 저장소의 소스와 테스트는 마지막 개발 commit과 같습니다.

## 라이선스

MIT. [LICENSE](LICENSE)를 참조합니다.
