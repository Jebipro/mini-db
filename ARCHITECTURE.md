# Mini DB — ARCHITECTURE

모듈 책임, 의존 방향, 핵심 인터페이스, 데이터 흐름, 디렉터리 구조.

> 출처: `DESIGN_REVIEW.md` rev1의 해당 섹션을 그대로 옮겼다(섹션 번호 유지). 변경은 `DECISIONS.md`에 기록한 뒤 두 문서를 함께 고친다.

## E.1 모듈과 책임

| 모듈 (`src/…`) | 책임 | 모르는 것 |
|---|---|---|
| `util/` | CRC32, PRNG(sfc32), 바이트 비교(`compareBytes`), UTF-8 헬퍼(`utf8Length`, `compareText`), `assertNever` | 그 외 전부 |
| `errors/` | `MiniDbError` 계층, 코드 상수, 위치 포맷터 | 그 외 전부 |
| `storage/` | `Vfs`/`StorageFile`(Node, Memory, Fault), 레이아웃 상수, 공통 페이지 헤더·CRC, 파일 헤더, WAL 파일, Pager(캐시·pin·트랜잭션·savepoint·커밋·checkpoint·복구·freelist·FAILED), 락 | 레코드, 행, 키, 카탈로그, SQL |
| `record/` | 값 타입(`Value`, `ColumnType`), 행 코덱, slotted heap page, heap file(체인·RID·스캔) | B+tree, 카탈로그, SQL |
| `btree/` | 키 인코딩, 노드 페이지 조작, B+tree(탐색·삽입·분할·lazy 삭제·커서·파괴·검사) | 카탈로그, SQL |
| `catalog/` | 스키마 타입(`TableSchema`, `IndexSchema`), 카탈로그 적재·검증·DDL 기록 | B+tree 알고리즘, SQL |
| `sql/` | 토큰, 렉서, AST, 파서, 분석기(Bound AST) | 페이지, 파일 |
| `exec/` | 표현식 평가기(3값 논리), 플래너, 플랜 노드, 연산자(SeqScan, IndexScan, Filter, Sort, Limit, Project), DML·DDL 실행, EXPLAIN 렌더러 | 파일 I/O, WAL |
| `engine/` | `Database` 공개 API, 문장·트랜잭션 수명 관리, 오류 감싸기·FAILED 전파, `integrityCheck`, `stats` 조립 | — |
| `cli/` | 인자 해석, REPL, 도트 명령, 출력 포맷 | 내부 모듈(오직 `engine` 공개 API만) |
| `index.ts` | 공개 export: `Database`, 오류 클래스, `MemoryVfs`, 타입 | |

## E.2 의존 방향 (단방향, T-ARCH-001이 import를 검사)

```text
cli     ──► engine (src/index.ts 공개 API만)
engine  ──► exec, sql, catalog, btree, record, storage
exec    ──► sql, catalog, btree, record, storage
sql     ──► catalog, record   (import type 만)
catalog ──► record ──► storage ──► util, errors
btree   ──► record, storage
```

허용 import 표(행 → 열을 import 가능):

| from \ to | util | errors | storage | record | btree | catalog | sql | exec | engine |
|---|---|---|---|---|---|---|---|---|---|
| util | — | | | | | | | | |
| errors | ✓ | — | | | | | | | |
| storage | ✓ | ✓ | — | | | | | | |
| record | ✓ | ✓ | ✓ | — | | | | | |
| btree | ✓ | ✓ | ✓ | ✓ | — | | | | |
| catalog | ✓ | ✓ | ✓ | ✓ | | — | | | |
| sql | ✓ | ✓ | | ✓ (타입만) | | ✓ (타입만) | — | | |
| exec | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | |
| engine | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| cli | | ✓ | | | | | | | ✓ (`src/index.ts` 경유) |

- "타입만" = `import type`만 허용.
- `node:fs`는 `storage/node-vfs.ts`, `cli/main.ts`(스크립트 파일 읽기)에서만. `node:crypto`는 `engine/database.ts`(기본 entropy)에서만. `node:process`의 `kill`은 `storage/lock.ts`에서만.

## E.3 데이터 흐름

```text
db.execute(sql)
  │  engine: FAILED/CLOSED 검사 → (트랜잭션 밖 & checkpointDue) checkpoint
  ▼
Lexer ─► Tokens ─► Parser ─► AST ─► Analyzer(catalog 스냅숏) ─► Bound AST
  ▼
engine: 트랜잭션 시작(암묵/명시) ─► pager.beginStatement()
  ▼
Planner ─► Plan tree ─► Executor(iterator)
  │            ├─ SeqScan ─► HeapFile ─► Pager
  │            ├─ IndexScan ─► BTree cursor ─► HeapFile.get ─► Pager
  │            └─ DML: 대상 수집 → 검사 → HeapFile/BTree 변경 ─► pager.markDirty
  ▼
성공: releaseStatement → (암묵) commitTxn ─► WAL append ─► fsync(F4)
실패: rollbackStatement → (암묵) rollbackTxn → 카탈로그 캐시 무효화 → 오류 rethrow
  ▼
ExecResult
```

```text
Pager.read(pageId):
  cache 적중 ─► 프레임
  WAL index에 있음 ─► WAL 프레임 읽기 ─► CRC/pageId 검증 ─► 프레임(clean)
  그 외 ─► 데이터 파일 읽기 ─► CRC/pageId 검증 ─► 프레임(clean)
```

## E.4 핵심 인터페이스 (타입 시그니처 수준)

```ts
// util
export type Rng = { nextU32(): number; nextInt(lo: number, hiInclusive: number): number; nextFloat(): number };
export function createRng(seed: number): Rng;               // sfc32 + splitmix32
export function crc32(data: Uint8Array, init?: number): number; // init = 이전 CRC(연속 계산)
export function compareBytes(a: Uint8Array, b: Uint8Array): -1 | 0 | 1;

// errors
export interface SourcePosition { offset: number; line: number; column: number }
export class MiniDbError extends Error {
  readonly code: string;
  readonly position?: SourcePosition;
  readonly sourceLine?: string;
  statementIndex?: number;
  format(): string;                                         // H.3 형식
}

// storage/vfs.ts
export interface StorageFile {
  readonly path: string;
  size(): number;
  read(dst: Uint8Array, position: number): number;          // 읽은 바이트 수(EOF에서 짧음)
  write(src: Uint8Array, position: number): void;           // 전부 쓰거나 throw
  sync(): void;
  truncate(size: number): void;
  close(): void;
}
export interface LockHandle { release(): void }
export interface Vfs {
  exists(path: string): boolean;
  open(path: string): StorageFile;                          // 없으면 생성
  syncDir(dirPath: string): void;                           // 미지원이면 no-op
  acquireLock(dbPath: string): LockHandle;                  // 실패 → StorageError DB_LOCKED
}
export class NodeVfs implements Vfs { /* … */ }
export class MemoryVfs implements Vfs {
  // durable 상태 / 현재 상태 / sync 이후 대기 연산 로그를 추적
  crashImage(policy: CrashPolicy, rng?: Rng): MemoryVfs;    // 크래시 후 디스크 상태
}
export type CrashPolicy = 'durable-only' | 'all-pending' | 'random-subset';
export interface FaultPlan {
  crashAtOp?: number;                                        // 1부터. write/sync/truncate/syncDir 통합 순번
  tornBytes?: number;                                        // crashAtOp이 write일 때 남길 접두 길이
  failAtOp?: number; failKind?: 'EIO';                       // 크래시 대신 I/O 오류
}
export class FaultVfs implements Vfs {
  constructor(base: MemoryVfs, plan: FaultPlan);
  readonly opLog: ReadonlyArray<{ seq: number; kind: 'write' | 'sync' | 'truncate' | 'syncDir'; file: string; position?: number; length?: number }>;
  readonly crashed: boolean;
}
export class SimulatedCrash extends Error {}                // MiniDbError가 아님 (DC-51 예외)

// storage/pager.ts
export type PageId = number;
export interface PageRef { readonly id: PageId; readonly data: Uint8Array }  // 캐시 프레임의 4096B 뷰
export interface PagerOptions {
  cachePages: number; walAutoCheckpointFrames: number;
  entropy: (n: number) => Uint8Array;
  initialize: (p: Pager) => void;                            // 새 DB bootstrap 트랜잭션 안에서 호출
}
export class Pager {
  static open(vfs: Vfs, path: string, opts: PagerOptions): Pager;  // 락·복구·생성 포함
  readonly state: 'open' | 'failed' | 'closed';
  get pageCount(): number;
  getRootPointer(): number; setRootPointer(pageId: PageId): void;  // 헤더 catalogRoot
  // 페이지 접근
  pin(id: PageId): PageRef;            unpin(ref: PageRef): void;
  markDirty(ref: PageRef): void;       // 수정 전에 반드시 호출. 트랜잭션 밖 → InternalError
  allocate(type: PageType): PageRef;   // pin + dirty + 0 초기화 + 공통 헤더
  free(id: PageId): void;              // FREE로 초기화해 freelist head에
  // 트랜잭션
  beginTxn(): void; commitTxn(): void; rollbackTxn(): void; inTxn(): boolean;
  beginStatement(): void; releaseStatement(): void; rollbackStatement(): void;
  // 유지
  checkpoint(): void; readonly checkpointDue: boolean;
  close(): void;
  stats(): PagerStats; resetStats(): void;
  totalPins(): number;
  markFailed(cause: unknown): void;
}

// record
export type ColumnType = 'INTEGER' | 'TEXT' | 'BOOLEAN';
export type Value = number | string | boolean | null;
export interface Rid { pageId: PageId; slot: number }
export function encodeRow(types: readonly ColumnType[], values: readonly Value[]): Uint8Array; // ROW_TOO_LARGE
export function decodeRow(types: readonly ColumnType[], bytes: Uint8Array): Value[];          // RECORD_MALFORMED
export class HeapFile {
  constructor(pager: Pager, headPage: PageId, types: readonly ColumnType[]);
  static create(pager: Pager): PageId;
  insert(values: readonly Value[]): Rid;
  get(rid: Rid): Value[] | null;                            // tombstone → null
  update(rid: Rid, values: readonly Value[]): Rid;          // 이동 시 새 RID
  delete(rid: Rid): void;
  scan(): HeapCursor;                                       // next(): { rid, values } | null, pin 보유 안 함
  destroy(): void;                                          // 모든 페이지 free
}

// btree
export function encodeKey(type: ColumnType, v: Exclude<Value, null>): Uint8Array;  // KEY_TOO_LARGE
export interface Entry { key: Uint8Array; rid: Rid }
export interface KeyBound { key: Uint8Array; inclusive: boolean }
export class BTree {
  constructor(pager: Pager, root: PageId, unique: boolean);
  static create(pager: Pager): PageId;                      // 빈 리프 루트
  findUnique(key: Uint8Array): Rid | null;
  insert(e: Entry): void;                                    // 유일 인덱스 중복 → InternalError (검사는 호출자 책임)
  delete(e: Entry): void;                                    // 없으면 InternalError
  scan(lo: KeyBound | null, hi: KeyBound | null): BTreeCursor; // next(): Entry | null
  destroy(): void;
  check(): IntegrityIssue[];
}

// catalog
export interface ColumnSchema { name: string; type: ColumnType; notNull: boolean; primaryKey: boolean; position: number }
export interface IndexSchema { name: string; table: string; column: string; unique: boolean; root: PageId; auto: boolean }
export interface TableSchema { name: string; columns: ColumnSchema[]; heapHead: PageId; indexes: IndexSchema[] /* 이름순 */ }
export class Catalog {
  static load(pager: Pager, heapOf: (head: PageId) => HeapFile): Catalog; // CATALOG_INVALID
  getTable(name: string): TableSchema | undefined;
  getIndex(name: string): IndexSchema | undefined;
  tables(): TableSchema[];                                  // 이름순
  addTable(t: TableSchema): void; dropTable(name: string): void;
  addIndex(i: IndexSchema): void; dropIndex(name: string): void;
}

// sql
export type Statement = SelectStmt | ExplainStmt | InsertStmt | UpdateStmt | DeleteStmt
  | CreateTableStmt | DropTableStmt | CreateIndexStmt | DropIndexStmt | TxnStmt;   // 각 노드에 pos: SourcePosition
export function tokenize(sql: string): Token[];
export function parseStatement(sql: string): Statement;      // 정확히 1문장
export function parseScript(sql: string): Statement[];
export function analyze(stmt: Statement, catalog: Catalog): BoundStatement;

// exec
export interface RowSource { open(): void; next(): Row | null; close(): void }
export interface Row { rid: Rid | null; values: Value[] }
export function plan(stmt: BoundSelect | BoundUpdate | BoundDelete, opts: { forceSeqScan: boolean }): PlanNode;
export function explain(p: PlanNode): string[];

// engine (공개 API)
export interface OpenOptions {
  vfs?: Vfs; cachePages?: number; walAutoCheckpointFrames?: number;
  entropy?: (n: number) => Uint8Array;
}
export type ExecResult =
  | { kind: 'rows'; columns: string[]; rows: Value[][] }
  | { kind: 'changes'; command: 'INSERT' | 'UPDATE' | 'DELETE'; changes: number }
  | { kind: 'ok'; command: 'CREATE TABLE' | 'DROP TABLE' | 'CREATE INDEX' | 'DROP INDEX' | 'BEGIN' | 'COMMIT' | 'ROLLBACK' };
export class Database {
  static open(path: string, options?: OpenOptions): Database;
  execute(sql: string, opts?: { forceSeqScan?: boolean }): ExecResult;
  executeScript(sql: string): ExecResult[];
  checkpoint(): void;
  integrityCheck(): IntegrityReport;
  stats(): DbStats; resetStats(): void;
  readonly inTransaction: boolean;
  readonly state: 'open' | 'failed' | 'closed';
  close(): void;
}
export interface DbStats {
  io: { dataPageReads: number; dataPageWrites: number; walFrameReads: number; walFrameWrites: number;
        dataSyncs: number; walSyncs: number; dirSyncs: number; walTruncates: number };
  cache: { hits: number; misses: number; evictions: number; capacity: number; cached: number; dirty: number };
  txn: { commits: number; rollbacks: number; statementRollbacks: number; checkpoints: number };
  wal: { frames: number; bytes: number };
  recovery: { framesScanned: number; framesApplied: number; txnsApplied: number; discardedTailBytes: number };
}
export interface IntegrityIssue { code: IntegrityCode; message: string; pageId?: number; object?: string }
export type IntegrityCode = 'HEADER_INVALID' | 'FILE_SIZE_MISMATCH' | 'PAGE_CORRUPT' | 'PAGE_LEAKED'
  | 'PAGE_MULTI_OWNED' | 'FREELIST_INVALID' | 'HEAP_CHAIN_INVALID' | 'SLOTTED_PAGE_INVALID' | 'RECORD_INVALID'
  | 'BTREE_SHAPE_INVALID' | 'BTREE_ORDER_INVALID' | 'BTREE_PAGE_INVALID' | 'INDEX_HEAP_MISMATCH' | 'CATALOG_INVALID';
export interface IntegrityReport {
  ok: boolean;                     // issues.length === 0
  issues: IntegrityIssue[];        // 최대 100개, 발견 순서
  summary: { pageCount: number; freePages: number; heapPages: number; btreePages: number;
             tables: number; indexes: number; rows: number; indexEntries: number };
}
```

- `stats()`의 `io`/`cache.hits·misses·evictions`/`txn`은 누적 카운터(`resetStats()`로 0), 나머지는 현재 값(gauge). `recovery`는 마지막 오픈 시 값.
- `integrityCheck()`는 CorruptionError를 throw하지 않고 `PAGE_CORRUPT` 이슈로 보고하지만, DC-49에 따라 핸들은 FAILED가 된다.

## E.5 디렉터리 구조

```text
mini-db/
  package.json  package-lock.json  tsconfig.json  tsconfig.build.json
  vitest.config.ts  vitest.long.config.ts  .gitignore  .gitattributes
  README.md SPEC.md FORMAT.md ARCHITECTURE.md DURABILITY.md TESTING.md BENCHMARKS.md
  LIMITATIONS.md FUTURE.md LEARNING.md DECISIONS.md PROGRESS.md REVIEW_PACKET.md DESIGN_REVIEW.md
  scripts/
    check-any.mjs            # typescript API로 src/의 AnyKeyword 검출 (+ Math.random/Date.now)
    check-docs.mjs           # 오류 코드·FSYNC 태그·T-ID 정합성 (--final: 모든 T-ID 구현 여부)
  src/
    index.ts
    util/      crc32.ts prng.ts bytes.ts utf8.ts assert.ts
    errors/    errors.ts codes.ts format.ts
    storage/   layout.ts vfs.ts node-vfs.ts memory-vfs.ts fault-vfs.ts page.ts file-header.ts
               wal.ts freelist.ts pager.ts lock.ts
    record/    value.ts row-codec.ts heap-page.ts heap-file.ts
    btree/     key-codec.ts node.ts btree.ts
    catalog/   schema.ts catalog.ts
    sql/       tokens.ts lexer.ts ast.ts parser.ts analyzer.ts bound.ts printer.ts
    exec/      eval.ts planner.ts plan.ts explain.ts operators.ts dml.ts ddl.ts
    engine/    database.ts integrity.ts stats.ts
    cli/       cli.ts format.ts main.ts
  tests/
    support/   harness.ts tmp.ts golden.ts dump.ts
    model/     ref-model.ts generator.ts render.ts compare.ts    # src/ import 금지(prng 제외)
    unit/      *.test.ts
    integration/ *.test.ts
    sql/       NNN-name.sql  NNN-name.expected
    fixtures/  empty-v1.db
    long/      random.long.test.ts  crash.long.test.ts
  bench/
    run.ts scenarios.ts report.ts
    results/   *.json   (tmp/ 는 gitignore)
```

### 스택·런타임

| ID | 영역 | 확정 규칙 | 예시·경계 | 번복 조건 |
|---|---|---|---|---|
| DC-01 | 언어/런타임 | TypeScript, Node ≥ 20, ESM(`"type": "module"`), `module`/`moduleResolution` = `NodeNext`, `target` = `ES2022` | 시작 시 `node --version` < 20이면 중단 | 없음 |
| DC-02 | 의존성 | 런타임 의존성 0. devDependencies는 `typescript`, `vitest`, `@types/node`만. `package-lock.json` 커밋 | `scripts/*.mjs`는 Node 내장 모듈과 `typescript` API만 사용 | 없음 |
| DC-03 | 파일 I/O | `node:fs` 동기 fd API만 사용하며 `Vfs`/`StorageFile` 인터페이스 뒤에 숨긴다. `src/` 다른 곳에서 `node:fs` import 금지 | `readSync`/`writeSync`는 부분 읽기·쓰기를 루프로 완결 | 비동기 환경(브라우저 등) 지원 요구 |
| DC-04 | tsconfig | `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noImplicitReturns`, `forceConsistentCasingInFileNames`. `exactOptionalPropertyTypes`는 끔 | 모든 union `switch`는 `assertNever(x)`로 끝남 | 없음 |

## 구현 반영 (DECISIONS.md)

- DEC-002: `assertNever`/`invariant`는 `src/errors/assert.ts` (util은 errors를 import할 수 없음).
- DEC-003: Node 잠금 구현은 `src/storage/node-vfs.ts` 안(`lock.ts` 없음), `Vfs.syncDir()`는 수행 여부를 boolean으로 반환, `CrashPolicy`에 `torn-only`.
- DEC-004: 언어 한도 상수는 `src/util/limits.ts` (layout.ts가 재export).
- DEC-005: `Database.executeScript(sql, onResult?)`, `Database.schema(): TableInfo[]` 추가.
- 추가 모듈: `src/exec/indexes.ts`(인덱스 키·유지 보조), `src/storage/stats.ts`(I/O 카운터), `src/storage/issues.ts`(무결성 이슈 타입·소유권 검사), `src/cli/format.ts`.
