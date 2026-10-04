# Mini DB — TESTING

테스트 계층, 테스트 ID(T-*) 정의, 참조 모델, 장애 주입, 재현 규칙, 실행 시간 예산, 스크립트.

> 출처: `DESIGN_REVIEW.md` rev1의 해당 섹션을 그대로 옮겼다(섹션 번호 유지). 변경은 `DECISIONS.md`에 기록한 뒤 두 문서를 함께 고친다.

## J.1 계층별 계획

| 계층 | 대상 | 위치 | 실행 |
|---|---|---|---|
| 단위 | util, storage(코덱·WAL·Pager), record, btree, sql, eval | `tests/unit/` | `npm test` |
| 통합 | `Database` API, DML/DDL, 트랜잭션, 플래너, CLI | `tests/integration/` | `npm test` |
| SQL 골든 | `tests/sql/NNN-*.sql` ↔ `.expected` | `tests/integration/golden.test.ts` | `npm test` |
| 모델 기반 무작위 | 참조 모델과 DB 동시 실행 | `tests/model/`, `tests/integration/model.test.ts`(짧게), `tests/long/random.long.test.ts` | `npm test`(짧게), `npm run test:random` |
| 장애 주입 | FaultVfs crash matrix | `tests/integration/crash-short.test.ts`, `tests/long/crash.long.test.ts` | `npm test`(부분), `npm run test:crash`(전수) |
| 손상 | 비트 플립·잘림·쓰레기 | `tests/integration/corruption.test.ts` | `npm test` |
| 구조·정합성 | 의존 방향, 오라클 독립성, 결정성, 문서 정합성 | `tests/unit/arch.test.ts`, `scripts/check-docs.mjs` | `npm test`, `npm run check:docs` |

테스트 이름은 반드시 ID로 시작한다: `it('T-WAL-004 torn tail frame is discarded', …)`. 한 ID가 여러 `it`을 가질 수 있다.

## J.2 테스트 ID 정의

**기반·구조**

| ID | 내용 | 단계 |
|---|---|---|
| T-ARCH-001 | `src/` import 그래프가 E.2 허용 표를 지킴(`typescript` API로 import 수집) | P1 |
| T-ARCH-002 | `tests/model/**`가 `src/`에서 `src/util/prng.ts` 외에는 import하지 않음 | P11 |
| T-ARCH-003 | `src/`·`tests/`에 `Math.random` 없음, `src/`에 `Date.now`/`new Date` 없음 | P1 |
| T-PRNG-001 | 같은 seed → 같은 수열, 첫 5개 출력 고정값, seed 다르면 다름 | P1 |
| T-ERR-001 | 모든 오류 클래스가 `MiniDbError` 하위, `name` 일치, 코드 형식, `codes.ts` 집합 = H.2 | P1 |
| T-ERR-002 | `format()` 출력: 위치·소스 줄·캐럿(탭·멀티바이트 포함), 위치 없는 형식, statementIndex 접미사 | P1(포맷터), P8(SQL) |
| T-ERR-003 | VFS가 `TypeError`를 던지면 `InternalError`로 감싸지고 FAILED | P10 |
| T-ERR-004 | 공개 API 인수 타입 오용(`execute(undefined)`, 비문자열 SQL, `null`/비객체 옵션, 비함수 `onResult`) → `UsageError INVALID_OPTION`, 핸들 `open`·열린 명시적 트랜잭션 유지(리뷰 L-1) | R1 |
| T-ERR-005 | `executeScript`의 `onResult` callback 예외는 원래 값 그대로 전파(InternalError로 감싸지 않음, statementIndex 미부여), 핸들 `open` 유지, 이미 완료된 문장 효과 유지·이후 문장 미실행, 명시적 트랜잭션은 열린 채 COMMIT/ROLLBACK 가능, callback 안 중첩 호출의 MiniDbError는 그 호출의 의미 유지(DEC-008) | R2 |
| T-TRACE-001 | `check-docs.mjs --final`: I의 모든 T-ID와 J.2의 모든 ID가 tests에 존재, FSYNC 태그 F1~F5 각 1회 이상, 오류 코드 집합 일치 | P15 |

**util·저장 기초**

| ID | 내용 | 단계 |
|---|---|---|
| T-CRC-001 | 알려진 벡터(`""`→0, `"123456789"`→0xCBF43926), 4096바이트 0 페이지 값을 테스트 안의 비트 단위 독립 구현과 비교 | P2 |
| T-CRC-002 | 연속 계산(`crc32(b, crc32(a))`) = 한 번에 계산 | P2 |
| T-VFS-001 | 같은 무작위 연산열(read/write/truncate/size)에 MemoryVfs와 NodeVfs 결과 동일 | P2 |
| T-VFS-002 | EOF에서 짧은 읽기, 파일 끝 너머 쓰기 시 사이 바이트 0 | P2 |
| T-VFS-003 | `crashAtOp=k`: k번째 연산에서 `SimulatedCrash`, 이후 모든 연산도 `SimulatedCrash` | P2 |
| T-VFS-004 | `durable-only`: sync 안 된 write/truncate 유실, sync된 것 유지 | P2 |
| T-VFS-005 | `tornBytes=t`: 크래시 write의 앞 t바이트만 남음 | P2 |
| T-VFS-006 | `random-subset`: 같은 seed → 같은 이미지, 다른 seed → (일반적으로) 다른 이미지 | P2 |
| T-VFS-007 | 디렉터리 sync 전 생성된 파일은 `durable-only`에서 사라지고, `syncDir` 후엔 남음 | P2 |
| T-VFS-008 | `failAtOp`: `StorageError IO_ERROR`, 크래시 아님 | P2 |
| T-PAGE-001 | 공통 헤더 인코드/디코드, CRC 계산·검증 왕복 | P2 |
| T-PAGE-002 | 한 페이지의 32768개 비트 각각을 뒤집으면 전부 검출 | P2 |
| T-PAGE-003 | 다른 위치에 쓴 페이지 → `PAGE_ID_MISMATCH`, 알 수 없는 타입 → `PAGE_TYPE_INVALID` | P2 |
| T-FMT-001 | 파일 헤더 왕복, magic/version/pageSize 오류 코드 | P2 |
| T-FMT-002 | 고정 entropy로 만든 빈 DB(8192바이트)가 `tests/fixtures/empty-v1.db`와 바이트 동일 | P7 |

**WAL**

| ID | 내용 | 단계 |
|---|---|---|
| T-WAL-001 | 헤더 왕복·CRC, 프레임 왕복, 체인 체크섬 계산이 D.8 정의와 일치(독립 계산과 비교) | P3 |
| T-WAL-002 | 트랜잭션 여러 개 append 후 scan → 페이지별 최신 커밋 프레임 | P3 |
| T-WAL-003 | COMMIT 프레임 없는 꼬리 트랜잭션 무시 | P3 |
| T-WAL-004 | 마지막 프레임을 1, 511, 512, 4096, 4119바이트로 찢으면 이전 트랜잭션만 인정 | P3 |
| T-WAL-005 | salt 불일치 프레임에서 중단 | P3 |
| T-WAL-006 | 중간 프레임 체인 깨짐 → 그 앞 커밋까지만 | P3 |
| T-WAL-007 | 리셋: truncate + 새 헤더, seq+1, 이전 프레임 안 보임 | P3 |
| T-WAL-008 | 헤더 무효 ∧ 크기 ≤ 48 → 빈 WAL, 크기 > 48 → `WAL_HEADER_INVALID` | P3 |
| T-WAL-009 | dbId 다름: 커밋 프레임 있으면 `WAL_MISMATCH`, 없으면 리셋 후 오픈 | P4 |
| T-WAL-010 | 체인 유효·페이지 CRC 무효 → `WAL_FRAME_INVALID` | P3 |

**Pager**

| ID | 내용 | 단계 |
|---|---|---|
| T-PGR-001 | 새 DB 생성(initialize 콜백), 재오픈 후 헤더·pageCount 유지 | P4 |
| T-PGR-002 | 적중/미스 카운터, LRU 축출 순서(clean 페이지) | P4 |
| T-PGR-003 | pin된 페이지는 축출 안 됨, unpin 과다 → `InternalError` | P4 |
| T-PGR-004 | 문장 종료 시 pin 남음 → `InternalError` + FAILED | P4 |
| T-PGR-005 | allocate/free/재사용, freelistCount 일관, 해제 페이지 FREE 타입 | P4 |
| T-PGR-006 | 커밋 후 close 없이 핸들 폐기 → 재오픈(복구 경로)하면 페이지 유지 | P4 |
| T-PGR-007 | 트랜잭션 롤백이 헤더(pageCount, freelist) 포함 모든 페이지 복원. Page 0 프레임은 캐시에 남고(미스 0회) clean이며 바이트가 마지막 커밋 이미지와 같음 | P4 |
| T-PGR-008 | 문장 롤백: 문장 전 txn 변경 유지, 문장 변경·신규 페이지 폐기. Page 0을 (a) 문장 전에 이미 dirty, (b) 이 문장에서 처음 dirty 두 경우 모두 프레임이 남고 각각 문장 전 이미지 / 커밋 이미지(clean)로 복원 | P4 |
| T-PGR-009 | 읽기 우선순위: dirty 캐시 > WAL index > 데이터 파일 | P4 |
| T-PGR-010 | checkpoint 후 WAL 크기 48, 데이터 파일만으로 같은 내용 | P4 |
| T-PGR-011 | dirty 한도 → `TXN_TOO_LARGE`, 문장 롤백, 트랜잭션 계속 사용 가능 | P4 |
| T-PGR-012 | 페이지 수준 모델 테스트: 무작위 트랜잭션(페이지 payload 쓰기, 할당·해제, 문장 롤백, 트랜잭션 롤백, checkpoint, 재오픈)을 `Map<PageId, bytes>` 모델과 비교 | P4 |
| T-PGR-013 | 자동 checkpoint: 임계 도달 시 다음 문장 시작에서 수행, 트랜잭션 중엔 미수행, 0이면 끔 | P5 |
| T-PGR-014 | 읽기 전용 트랜잭션 커밋은 write·fsync 0회 | P4 |
| T-PGR-015 | pageId ≥ pageCount 읽기 → `PAGE_OUT_OF_RANGE` | P4 |
| T-PGR-016 | 같은 연산열·entropy에서 MemoryVfs와 NodeVfs의 최종 파일 바이트 동일 | P5 |

**실패 상태·잠금·통계**

| ID | 내용 | 단계 |
|---|---|---|
| T-FAIL-001 | 커밋 fsync 실패 → `IO_COMMIT_UNKNOWN`, 이후 `DB_FAILED`, close 성공, 재오픈 상태 ∈ {S, S⁺} | P5 |
| T-FAIL-002 | checkpoint write 실패 → FAILED, 재오픈 상태 = S | P5 |
| T-FAIL-003 | 읽기 EIO → `IO_ERROR`, 핸들 계속 사용 가능, 상태 불변 | P5 |
| T-FAIL-004 | 페이지 읽기 중 CorruptionError → FAILED, 이후 `DB_FAILED`(P14에서 SQL 질의로도 확인) | P5 |
| T-LOCK-001 | 같은 프로세스에서 같은 경로 이중 `acquireLock` → `DB_LOCKED`(경로 표기 달라도) | P2 |
| T-LOCK-002 | 종료된 자식 프로세스 PID가 든 락 파일 → stale 처리 후 획득 성공(NodeVfs) | P2 |
| T-LOCK-003 | 살아 있는 자식 프로세스 PID 락 → `DB_LOCKED` (Windows에서 `process.kill(pid,0)` 동작 확인 포함) | P2 |
| T-LOCK-004 | `release()` 후 재획득 가능(P10에서 `close()`로도 확인), 파싱 불가 락 파일 → `DB_LOCKED` | P2 |
| T-STAT-001 | 자동 커밋 쓰기 1문장 = walSyncs 1, 읽기 전용 = 0, checkpoint = dataSyncs 1 + walSyncs 2, `resetStats` 동작 | P5, P10 |

**페이지 수준 크래시**

| ID | 내용 | 단계 |
|---|---|---|
| T-CRASH-P01 | 페이지 수준 crash matrix(J.5, 워크로드 PW1) 전 지점 × 전 정책, 오라클 = 페이지 모델 ∈ {S, S⁺} | P5 |
| T-CRASH-P02 | 복구 중 재크래시: PW1 크래시 이미지마다 복구 연산 전 지점에서 다시 크래시 → 재오픈 결과가 단일 복구 결과와 같음 | P5 |
| T-CRASH-P03 | 생성 중 전 지점 크래시 → 재오픈 성공(빈 DB), Corruption 없음 | P5 |

**레코드·카탈로그**

| ID | 내용 | 단계 |
|---|---|---|
| T-ROW-001 | 무작위 행 코덱 왕복(NULL, ±MAX_SAFE, 0, 빈 문자열, 멀티바이트, 이모지) | P6 |
| T-ROW-002 | 크기 공식 정확, 4060 성공·4061 `ROW_TOO_LARGE` | P6 |
| T-ROW-003 | 잘못된 바이트(BOOLEAN 2, 잘못된 UTF-8, 길이 초과, 컬럼 수 불일치, 범위 밖 int64, 남는 바이트) → `RECORD_MALFORMED` | P6 |
| T-HP-001 | slotted page 삽입·조회·삭제·갱신 기본 | P6 |
| T-HP-002 | 무작위 연산 후 매번 I6 기하 검사 + 배열 모델과 내용 비교 | P6 |
| T-HP-003 | compaction 후 모든 slot 번호·내용 보존, tombstone 최저 번호 재사용 | P6 |
| T-HP-004 | 경계: 연속 공간을 정확히 채우는 삽입, need+1 → compaction 또는 no-space, no-space 갱신 시 페이지 바이트 불변 | P6 |
| T-HP-005 | 꼬리 tombstone 잘라내기 | P6 |
| T-HEAP-001 | 힙 파일 무작위 모델 테스트(insert/update/delete/scan, 여러 페이지, 재오픈) | P6 |
| T-HEAP-002 | 이동하는 갱신은 다른 페이지의 새 RID, 옛 RID는 tombstone | P6 |
| T-HEAP-003 | 체인 무결성 검사가 순환·잘못된 tailPage·누수 페이지를 검출(테스트가 CRC를 다시 계산해 구조만 망가뜨림) | P6 |
| T-CAT-001 | 테이블·인덱스 생성·조회·삭제, 재오픈 후 유지 | P7 |
| T-CAT-002 | 이름 중복(테이블/테이블, 테이블/인덱스, 대소문자) → `OBJECT_EXISTS` | P7 |
| T-CAT-003 | CRC는 유효하지만 의미가 틀린 카탈로그 → `CATALOG_INVALID` | P7 |
| T-CAT-004 | DROP TABLE이 모든 페이지를 freelist로(정확한 개수), 소유권 검사 통과 | P7 |
| T-CAT-005 | 트랜잭션 안 CREATE 후 ROLLBACK → 없음, DROP 후 ROLLBACK → 데이터와 함께 복원 | P10 |

**SQL 프런트엔드**

| ID | 내용 | 단계 |
|---|---|---|
| T-LEX-001 | 토큰 종류·위치(`\n`, `\r\n`, 탭, 멀티바이트·이모지 column) | P8 |
| T-LEX-002 | `''` 이스케이프, 줄바꿈 포함 문자열, 닫히지 않은 문자열 위치 | P8 |
| T-LEX-003 | 주석, 키워드 대소문자, 식별자 소문자화, 64/65바이트 식별자 | P8 |
| T-LEX-004 | 정수 리터럴 9007199254740991 성공, …992 `INTEGER_OUT_OF_RANGE`, `123abc` → `SYNTAX_INVALID_NUMBER` | P8 |
| T-LEX-005 | lone surrogate → `SYNTAX_INVALID_STRING`, 4000/4001바이트 문자열, 허용 안 된 문자 | P8 |
| T-PAR-001 | 문법 골든: EBNF 각 생성 규칙의 정상 1개 이상·오류 1개 이상(`tests/unit/parser-cases.ts`) | P8 |
| T-PAR-002 | 우선순위·결합 표(F.3)의 모든 행 | P8 |
| T-PAR-003 | 비결합 비교 `a = b = c`, `a = b IS NULL` → 구문 오류 | P8 |
| T-PAR-004 | 오류 메시지의 기대 토큰과 위치 | P8 |
| T-PAR-005 | 퍼징: 유효 SQL 변형·무작위 토큰열 → 성공 또는 `SqlSyntaxError`/`LimitError`만(seed) | P8 |
| T-PAR-006 | 테스트 소유 생성기가 EBNF대로 만든 무작위 문장 → 파서 수락, `printer` 출력 재파싱 시 같은 AST | P8 |
| T-ANA-001 | 이름 해석 오류 코드와 위치 | P9 |
| T-ANA-002 | 타입 규칙 행렬: 모든 연산자 × 피연산자 타입 쌍 | P9 |
| T-ANA-003 | DDL 검사 A5~A10, A14 | P9 |
| T-ANA-004 | INSERT 검사 A11~A13 | P9 |
| T-EVAL-001 | AND/OR/NOT 진리표 전수(27+3) | P9 |
| T-EVAL-002 | NULL 비교·산술 전파, IS NULL 결과는 NULL 아님 | P9 |
| T-EVAL-003 | `+ − *`·단항 `−` 경계 오버플로(±MAX_SAFE) | P9 |
| T-EVAL-004 | TEXT 비교가 UTF-8 바이트 순서(U+FF61 vs U+1F600, 'B' < 'a', '' < 'a') | P9 |
| T-EVAL-005 | 단락 평가: `FALSE AND (오버플로 식)`은 오류 없음, `TRUE AND (…)`는 오류 | P9 |

**실행기·API·CLI**

| ID | 내용 | 단계 |
|---|---|---|
| T-EXEC-001 | 생성·삽입·조회·수정·삭제·재오픈 종단 간 | P10 |
| T-EXEC-002 | 다중 행 INSERT의 k번째 행 실패 → 0행 삽입(자동 커밋·명시적 트랜잭션 모두) | P10 |
| T-EXEC-003 | `UPDATE … SET id = id + 1` 성공, 충돌은 실패하고 부분 적용 없음 | P10 |
| T-EXEC-004 | 행을 키워 이동시키는 UPDATE가 모든 행을 정확히 1회 갱신(Halloween) | P10 |
| T-EXEC-005 | ORDER BY NULL 위치(ASC/DESC), 다중 키 | P10 |
| T-EXEC-006 | `LIMIT 0`, OFFSET ≥ 행 수, LIMIT/OFFSET 경계 | P10 |
| T-EXEC-007 | NOT NULL·UNIQUE 위반 코드, UNIQUE에 NULL 여러 개 허용 | P10 |
| T-EXEC-008 | `TXN_ALREADY_ACTIVE`/`TXN_NOT_ACTIVE`, 명시적 트랜잭션 안 오류 후 트랜잭션·이전 변경 유지 | P10 |
| T-EXEC-009 | 명시적 트랜잭션의 DDL + ROLLBACK | P10 |
| T-EXEC-010 | EXPLAIN SeqScan 형태 정확한 문자열 | P10 |
| T-EXEC-011 | 결과 형태(rows/changes/ok), 컬럼 이름, `*` 확장, 0행 결과의 columns | P10 |
| T-EXEC-012 | `execute` 다중 문장·빈 문장 오류, `executeScript` 첫 오류 중단과 `statementIndex` | P10 |
| T-EXEC-013 | SQL로 행 크기 경계(4060/4061) | P10 |
| T-EXEC-014 | 활성 트랜잭션 상태로 close → 재오픈 시 트랜잭션 전 상태 | P10 |
| T-EXEC-015 | `TXN_TOO_LARGE`(작은 cachePages)에서 명시적 트랜잭션이 유지되고 이후 COMMIT 가능 | P10 |
| T-GOLD-001 | SQL 골든 스위트(CRLF 정규화 후 비교) | P10 |
| T-CLI-001 | `-c` 실행 출력 형식과 종료 코드 0/1/2/3 | P11 |
| T-CLI-002 | REPL 여러 줄 문장, 문자열 안 `;`, 도트 명령, `.quit` | P11 |
| T-CLI-003 | `-f` 스크립트, 첫 오류에서 중단, 종료 코드 1, `(statement n)` | P11 |
| T-LIM-001 | 컬럼 64/65, 식별자 64/65바이트, TEXT 4000/4001바이트를 SQL로 | P10 |

**모델 기반**

| ID | 내용 | 단계 |
|---|---|---|
| T-MODEL-001 | 인덱스 없는 무작위 문장열(짧게: 20 seeds × 300 steps) | P11 |
| T-MODEL-002 | 인덱스 생성·삭제를 섞은 무작위(PK 테이블, 비유일·유일 인덱스) | P13 |
| T-MODEL-003 | BEGIN/COMMIT/ROLLBACK, 트랜잭션 안 실패 문장, 주기적 재오픈 | P11 |
| T-MODEL-004 | 오라클 자체 검증: 손으로 쓴 기대값 표로 참조 모델의 평가기·정렬·제약 판정 확인 | P11 |
| T-MODEL-005 | 같은 seed 두 번 실행 시 문장열·결과 trace가 바이트 동일 | P11 |

**B+tree·인덱스·플래너**

| ID | 내용 | 단계 |
|---|---|---|
| T-KEY-001 | 무작위 값 쌍: `sign(compareValues) = sign(compareBytes(encode))`(MIN/MAX_SAFE, 0, −1, '', 멀티바이트, BOOLEAN) | P12 |
| T-KEY-002 | TEXT 키 512바이트 성공, 513 `KEY_TOO_LARGE` | P12 |
| T-BT-001 | 작은 트리 삽입·탐색 | P12 |
| T-BT-002 | 무작위 삽입·삭제를 정렬 배열 모델과 비교(유일·비유일), 50연산마다 검사기 | P12 |
| T-BT-003 | 512바이트 키로 3단 이상 트리 강제, 리프·내부 루트 분할 모두 발생, 루트 페이지 ID 불변 | P12 |
| T-BT-004 | 범위 스캔 경계 조합(포함/배타/무한/빈 범위/lo>hi)을 모델과 비교 | P12 |
| T-BT-005 | 비유일: 같은 키 수백 개가 여러 리프에 걸침, seek가 첫 항목을 찾음 | P12 |
| T-BT-006 | 전부 삭제 → 빈 리프 유지, 스캔 0건, 재삽입 정상, 검사기 통과 | P12 |
| T-BT-007 | 검사기가 일부러 만든 위반(정렬 깨짐, 리프 연결 끊김, 깊이 불일치, separator 범위 위반)을 검출 | P12 |
| T-BT-008 | `destroy` 후 모든 노드 페이지가 freelist에 | P12 |
| T-IDX-001 | 기존 데이터로 CREATE UNIQUE INDEX 중 중복 → `UNIQUE_VIOLATION`, 인덱스 없음, 누수 페이지 0 | P13 |
| T-IDX-002 | INSERT/UPDATE(값 변경·행 이동)/DELETE 후 매번 I11 통과 | P13 |
| T-IDX-003 | PK 자동 인덱스 `mdb_pk_<t>` 존재, DROP 불가 | P13 |
| T-IDX-004 | NULL 미색인, UNIQUE 다중 NULL, `IS NULL`은 SeqScan | P13 |
| T-IDX-005 | INSERT/UPDATE/CREATE INDEX의 `KEY_TOO_LARGE` | P13 |
| T-PLAN-001 | F.8 규칙별 플랜 모양(유일 = > 비유일 = > 범위, 이름순, 뒤집힌 리터럴, `-5`, `col = NULL`·`<>`·OR·컬럼끼리는 인덱스 미사용) | P13 |
| T-PLAN-002 | EXPLAIN IndexScan 범위 표기 | P13 |
| T-DIFF-001 | 무작위 질의를 `forceSeqScan`과 기본 플랜으로 실행해 결과 동일(seed) | P13 |

**무결성·크래시·손상**

| ID | 내용 | 단계 |
|---|---|---|
| T-INTEG-001 | 모든 통합 테스트 하네스가 테스트 종료 시 `integrityCheck().ok` 단언 | P10(힙), P13(인덱스) |
| T-INTEG-002 | I1~I12 각각을 일부러 위반한 DB(CRC 재계산)에서 해당 이슈 코드 보고 | P14 |
| T-INTEG-003 | 보고 형식, 이슈 100개 상한, summary 값 | P14 |
| T-INTEG-004 | I11 내용 비교: 항목 수는 같고 RID가 죽은 slot(dangling)·다른 값의 살아 있는 행·PK 키가 틀린 경우 모두 `INDEX_HEAP_MISMATCH`(count만 비교하는 약화 변이 M11을 `npm run check`가 잡음, 리뷰 TG-1) | R1 |
| T-CRASH-001 | SQL 수준 crash matrix CW1~CW5 × 정책(J.5) | P14 |
| T-CRASH-002 | SQL 수준 복구 중 재크래시(CW6) | P14 |
| T-CRASH-003 | checkpoint 내부 6개 지점(데이터 write, F5, truncate, F2, 헤더 write, F3) 각각이 matrix에서 1회 이상 크래시됨을 단언 | P14 |
| T-CRASH-004 | opLog 패턴 검사: 커밋 = `write(wal)+ → sync(wal)`, checkpoint = `write(data)+ → sync(data) → truncate(wal) → sync(wal) → write(wal) → sync(wal)` | P5, P14 |
| T-CRASH-005 | 무작위 워크로드 + 무작위 크래시 지점·정책(long, seeds) | P14 |
| T-CRASH-006 | 복구 중 재크래시 확장(CW4·CW5, P-ALL 이미지 4지점마다): 복구 연산마다 P-TORN(1, 2048바이트)·P-RANDOM(s=1)으로 다시 크래시, 5번째 연산마다 이중 크래시(복구의 복구도 크래시) → 단일 복구 결과와 같음, integrity ok. `CRASH_RECOVERY_STRIDE`/`CRASH_RECOVERY_SEEDS`로 확대(리뷰 TG-2) | R1 |
| T-CORR-001 | checkpoint된 DB의 페이지 타입별로 비트 플립 → 오픈/전체 SELECT/integrityCheck 중 하나에서 Corruption(이슈 또는 오류), 다른 예외·다른 데이터 반환 없음 | P14 |
| T-CORR-002 | WAL 헤더 비트 플립(크기>48) → `WAL_HEADER_INVALID`, 프레임 비트 플립 → 커밋 접두 상태 + 무결성 통과 | P14 |
| T-CORR-003 | 무작위 바이트 파일·4096 미만·pageCount보다 짧은 파일 → `NOT_A_DATABASE`/`FILE_TRUNCATED` | P14 |
| T-CORR-004 | 다른 DB의 WAL(커밋 프레임 포함) → `WAL_MISMATCH` | P14 |
| T-BENCH-001 | 벤치마크 하네스 스모크(N 아주 작게): JSON 필수 필드 존재 | P16 |

## J.3 참조 모델 설계

- 위치: `tests/model/`. `src/` import 금지(`src/util/prng.ts`만 예외, T-ARCH-002).
- 상태: `Map<tableName, { columns: {name, type, notNull, pk}[]; rows: Value[][]; uniqueCols: Set<string>; indexes: Map<name, {column, unique}> }>`. 행 순서는 의미 없음.
- 생성기는 **테스트 소유 AST**(`GenStmt`)를 만든다. `render.ts`가 SQL 텍스트로 바꿔 DB에 보내고, `ref-model.ts`가 `GenStmt`를 직접 해석한다(SQL 파싱 없음).
- 평가기: 3값 논리를 JS로 직접 구현(`true | false | null`), 비교는 `Buffer.compare(Buffer.from(a,'utf8'), …)`, 오버플로 판정은 `Number.isSafeInteger`.
- 판정 결과: `{ ok: true, result } | { ok: false, codes: Set<ErrorCode> }`. 모델은 문장 실패 여부와 **가능한 오류 코드 집합**을 계산한다(여러 위반이 동시에 있으면 모두 포함).
- 트랜잭션: BEGIN 시 깊은 복사 스냅숏, ROLLBACK 시 복원. 문장 실패 시 문장 직전 스냅숏으로 복원.
- UPDATE 유일성: 최종 상태(비대상 ∪ 새 행)에서 각 유일 컬럼의 NULL 아닌 값 중복 여부(DC-31과 동치).
- 보장하는 것: 결과 행(다중집합 또는 전순서), 변경 행 수, 실패 여부와 코드 집합 포함 관계, 문장·트랜잭션 원자성, 깨끗한 재오픈 후 지속성, DDL 의미.
- 보장하지 못하는 것(별도 오라클 필요): 크래시 의미론(J.5), 물리 포맷(T-FMT-002·무결성 검사), 플랜 선택(T-PLAN-*), 오류 위치·메시지(T-ERR-*, T-PAR-004), ORDER BY 없는 결과 순서, 성능.

## J.4 무작위 생성기와 비교 규칙

| 항목 | 규칙 |
|---|---|
| 스키마 | 테이블 1~3개, 컬럼 2~6개, 타입 무작위, 각 테이블은 INTEGER PK를 가질 확률 0.8. T-MODEL-002는 유일/비유일 인덱스를 생성·삭제 |
| 값 분포 | INTEGER: [−20, 20] 85%, 경계(0, ±1, ±MAX_SAFE, ±(MAX_SAFE−1)) 15%. TEXT: `''`, `'a'`~`'e'`, `'é'`, `'한'`, `'😀'`, `'ｱ'`(U+FF71), 길이 0~6 조합. BOOLEAN. NULL 15% |
| 문장 비율 | INSERT 30, SELECT 25, UPDATE 15, DELETE 10, BEGIN/COMMIT/ROLLBACK 합 8, DDL 5, 의도적 실패(중복 PK, NOT NULL, 오버플로 SET, 알 수 없는 컬럼) 5, 재오픈 2 |
| WHERE | 비교·AND/OR/NOT/IS NULL과 작은 정수 산술만. **오버플로 가능한 식은 WHERE에 넣지 않음**(DC-43) |
| 오버플로 | INSERT 값과 UPDATE SET에만(대상 집합이 결정적이므로 모델이 정확히 예측) |
| LIMIT/OFFSET | ORDER BY가 PK 컬럼으로 끝나는(전순서) SELECT에만 |
| 비교 | ORDER BY가 전순서면 순서 비교, 아니면 정렬 키 그룹별 다중집합, ORDER BY 없으면 전체 다중집합(정규화 JSON 정렬) |
| 오류 비교 | DB 실패 ⇔ 모델 실패, DB 코드 ∈ 모델 코드 집합. 실패 후 다음 SELECT로 상태 동일 확인 |
| 주기 검사 | 50 step마다 `integrityCheck()`(트랜잭션 밖일 때), 재오픈 후 전체 테이블 덤프 비교 |
| 실패 출력 | seed, step 번호, 최근 20개 SQL, 기대/실제, 재현 명령(J.7) |

## J.5 장애 주입 설계와 crash matrix

`MemoryVfs`는 파일마다 `durable` 바이트, `current` 바이트, 마지막 sync 이후 대기 연산 로그(write/truncate)를 가진다. 파일 생성은 부모 디렉터리 `syncDir` 전까지 대기 상태다.

`FaultVfs`는 모든 변경 연산(`write`, `sync`, `truncate`, `syncDir`)에 전역 순번을 매기고 `opLog`에 기록한다.

크래시 후 이미지(`crashImage(policy)`) 정책:

| 정책 | 대기 write/truncate | 크래시 write | 미sync 파일 생성 |
|---|---|---|---|
| P-DURABLE | 전부 유실 | 유실 | 사라짐 |
| P-ALL | 전부 반영 | `tornBytes`만큼 반영 | 유지 |
| P-TORN(t) | 전부 유실 | 앞 t바이트 반영, t ∈ {1, 511, 512, 4096, len−1} 중 len 미만 | 유지 |
| P-RANDOM(s) | 각 연산을 원래 순서로 독립적으로: 유실 1/3, 반영 1/3, 512배수 접두만 반영 1/3 (truncate는 유실/반영 1/2) | 유실 | 1/2 |

워크로드:

| ID | 내용 | 수준 |
|---|---|---|
| PW1 | Pager 직접: 페이지 쓰기 트랜잭션 12개(할당·해제·롤백 섞음), `walAutoCheckpointFrames=5`, 중간 `checkpoint()` 2회 | 페이지 |
| CW1 | 새 DB 생성 후 close | SQL |
| CW2 | `CREATE TABLE` + 자동 커밋 INSERT 5개 | SQL |
| CW3 | 명시적 트랜잭션 INSERT 40행(여러 페이지) COMMIT, 이어서 ROLLBACK되는 트랜잭션, UPDATE·DELETE | SQL |
| CW4 | PK + 보조 인덱스, B+tree 분할을 일으키는 INSERT, 행 이동 UPDATE, DELETE | SQL |
| CW5 | `walAutoCheckpointFrames=4`, 명시적 `checkpoint()`, `DROP TABLE`(freelist), `CREATE INDEX` | SQL |
| CW6 | CW4·CW5의 WAL이 비어 있지 않은 크래시 이미지마다, 재오픈(복구) 연산 전 지점에서 다시 크래시(T-CRASH-002: P-DURABLE·P-ALL; T-CRASH-006: P-TORN·P-RANDOM·이중 크래시) | SQL |

절차(워크로드 W, 정책 P, 지점 k):
1. 무결점 실행으로 W의 총 연산 수 N과 각 트랜잭션 경계를 기록. 참조 모델(페이지 수준은 `Map` 모델)로 상태 S₀…S_m 계산.
2. `FaultVfs(crashAtOp=k)`로 W 실행 → `SimulatedCrash`까지 성공 반환된 커밋 수 a 기록.
3. `crashImage(P)`로 새 `MemoryVfs`를 만들어 오픈(장애 없음).
4. 단언: (a) 오픈 성공, (b) `integrityCheck().ok`, (c) 덤프 ∈ {S_a, S_{a+1}}(진행 중 트랜잭션이 없으면 S_a만), (d) close 후 다시 열어도 같은 덤프(복구 멱등).
5. k = 1…N 전부, P 전부(P-RANDOM은 s = 1, 2, 3).

| 스위트 | 내용 | 예상 실행 수 |
|---|---|---|
| `npm test` (crash-short) | CW2 × {P-DURABLE, P-TORN(512)} 전 지점, PW1 × P-DURABLE 전 지점 | ~300 |
| `npm run test:crash` | PW1, CW1~CW6 × 모든 정책 × 전 지점, 무작위 워크로드(T-CRASH-005), 복구 재크래시 확장(T-CRASH-006, 약 1.2천 회 + 이중 크래시 약 160회) | 수천~2만 (≤ 15분) |

## J.6 손상 테스트

- 대상 DB: CW4 종료 후 `close()`(WAL 빈 상태)한 이미지.
- 페이지 비트 플립: HEADER, 카탈로그 HEAP, 테이블 HEAP, BTREE_INTERNAL, BTREE_LEAF, FREE 각 타입에서 seed로 고른 페이지 3개 × 비트 5개.
- 기대: `Database.open` 또는 모든 테이블 `SELECT *` 또는 `integrityCheck()`에서 `CorruptionError`(또는 `PAGE_CORRUPT` 이슈). FREE 페이지 손상은 integrityCheck에서 검출. 어떤 경우에도 `MiniDbError`가 아닌 예외, 원본과 다른 행 반환이 없어야 한다.
- WAL: 커밋 3개가 든 WAL 이미지(close 없이 핸들 폐기)에서 헤더 비트 → `WAL_HEADER_INVALID`, 프레임 비트 → 상태 ∈ {S₀…S₃}이고 무결성 통과.
- 파일 수준: 무작위 바이트 10KB, 1000바이트 파일, pageCount보다 한 페이지 짧은 파일.

## J.7 seed 재현 규칙

- 환경 변수: `SEED`(단일 seed), `SEEDS`(개수, 기본: short 20 / long 200), `SEED_START`(기본 1), `STEPS`(기본: short 300 / long 1000).
- 실패 메시지 마지막 줄 형식:
  - `REPRO (bash): SEED=<s> STEPS=<n> npx vitest run --config vitest.long.config.ts tests/long/random.long.test.ts`
  - `REPRO (PowerShell): $env:SEED=<s>; $env:STEPS=<n>; npx vitest run --config vitest.long.config.ts tests/long/random.long.test.ts`
- 크래시 실패: `workload=<CWn> policy=<P> op=<k> seed=<s>`와 같은 형식의 재현 명령(`CRASH_CASE=CW4:P-RANDOM:137:2`).
- 무작위 테스트가 실패하면 그 seed를 `tests/integration/regressions.test.ts`의 고정 seed 목록에 추가한다(수정 후에도 유지).

## J.8 실행 시간 예산

| 명령 | 예산(개발 머신) | 초과 시 |
|---|---|---|
| `npm test` | ≤ 60초(목표 30초) | 짧은 스위트의 seed/지점 수를 줄이고 long으로 이동. 테스트 삭제 금지 |
| 단일 테스트 파일 | ≤ 10초(`testTimeout` 10000) | 분할 |
| `npm run test:random` | 기본 설정 ≤ 10분 | `SEEDS`로 조절 |
| `npm run test:crash` | ≤ 15분 | 정책별 분할 실행 옵션 `CRASH_POLICY` |

## J.9 스크립트와 설정

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "check:any": "node scripts/check-any.mjs",
    "check:docs": "node scripts/check-docs.mjs",
    "test": "vitest run",
    "test:random": "vitest run --config vitest.long.config.ts tests/long/random.long.test.ts",
    "test:crash": "vitest run --config vitest.long.config.ts tests/long/crash.long.test.ts",
    "check": "npm run typecheck && npm run check:any && npm run check:docs && npm test",
    "cli": "npm run build && node dist/src/cli/main.js",
    "bench": "npm run build && node dist/bench/run.js"
  }
}
```

- `tsconfig.json`: `src`, `tests`, `bench`, `scripts` 타입 검사(noEmit). `tsconfig.build.json`: `src`, `bench`만, `rootDir: "."`, `outDir: "dist"`.
- `vitest.config.ts`: include `tests/{unit,integration}/**/*.test.ts`, `testTimeout: 10000`. `vitest.long.config.ts`: include `tests/long/**/*.long.test.ts`, `testTimeout: 900000`.
- `check-any.mjs`: `typescript` API로 `src/**/*.ts`의 `AnyKeyword` 노드를 찾음. 같은 줄 `// any-allowed: <사유>`만 예외. `Math.random`/`Date.now`/`new Date`(DC-66)도 같은 스크립트가 검사.
- `check-docs.mjs`(기본 모드, P1부터 `check`에 포함): (1) `src/errors/codes.ts` 코드 집합 = SPEC.md 오류 표(SPEC.md가 아직 없으면 DESIGN_REVIEW.md H.2), (2) `// FSYNC-Fn` 태그가 DURABILITY.md 목록의 부분집합, (3) tests의 `it('T-…')` ID가 모두 TESTING.md(없으면 이 문서 J.2)에 정의됨. `--final` 모드(P15부터 게이트): 반대 방향까지 — J.2·I의 모든 T-ID 구현, F1~F5 태그 전부 존재.
- 테스트 간 상태 공유 금지. 파일 시스템 테스트는 `fs.mkdtempSync(os.tmpdir()/minidb-)` 디렉터리를 쓰고 `afterEach`에서 삭제.

## 구현 반영

- 장애 정책 P-TORN은 `CrashPolicy 'torn-only'`로 구현(DEC-003). 페이지 수준 하네스: `tests/support/page-crash.ts`, SQL 수준: `tests/support/sql-crash.ts`, 모델 러너: `tests/support/model-runner.ts`.
- `check:docs --upto=N`: 단계 N 이하의 테스트 ID만 존재를 요구(T-TRACE-001이 사용, 최종 게이트는 `--final`).
- 재현: 무작위 `SEED/SEEDS/SEED_START/STEPS`, 크래시 `CRASH_POLICY`(정책 접두사), `CRASH_WORKLOAD`(CW 이름) 필터.
- 독립 리뷰 후속(R1, CLAUDE_INDEPENDENT_REVIEW.md): T-ERR-004(L-1), T-INTEG-004(TG-1), T-CRASH-006(TG-2)을 정규 스위트에 편입. T-CRASH-006은 리뷰의 REVIEW-CR-001(약 5천 회)의 결정적 부분집합이며, 확대는 `CRASH_RECOVERY_STRIDE=1 CRASH_RECOVERY_SEEDS=3`. 리뷰 전용 테스트는 `npx vitest run --config vitest.review.config.ts`(`tests/review/`).
