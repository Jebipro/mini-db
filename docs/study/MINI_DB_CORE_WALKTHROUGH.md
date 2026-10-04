# Mini DB Core Walkthrough

> 이 문서는 Mini DB를 **AI 없이 자기 말로 설명하기 위한** 학습 자료이자 코드 walkthrough, 면접 설명 자료,
> 포트폴리오 기술 근거다. 모든 설명은 커밋 `746d5ba` 시점의 실제 코드와 문서(DESIGN_REVIEW rev1, DURABILITY,
> SPEC, TESTING, DECISIONS, CLAUDE_INDEPENDENT_REVIEW)를 근거로 한다. `파일:줄`은 그 시점의 위치다.
>
> 읽는 법: 각 절의 "한 줄 요약"을 먼저 읽고, 코드를 열어 따라간 뒤, 마지막 Self Check로 스스로 확인한다.

---

## A. 프로젝트 전체 지도

**한 줄 요약**: SQL 문자열 하나가 위에서 아래로 9개 계층을 지나고, 디스크에 닿는 것은 맨 아래 VFS뿐이다.

```text
db.execute("UPDATE t SET v = 'x' WHERE id = 3")
 │
 ├─ engine/database.ts        Database API: 인수 검사, 문장·트랜잭션 수명, 오류 감싸기(FAILED)
 ├─ sql/lexer.ts, parser.ts   토큰 → AST (재귀 하강 + precedence climbing)
 ├─ sql/analyzer.ts           이름 해석·타입 검사 → Bound AST (카탈로그 조회)
 ├─ exec/planner.ts           규칙 기반 접근 경로 선택: SeqScan | IndexScan + Filter
 ├─ exec/operators.ts         Volcano iterator: open / next / close
 ├─ exec/dml.ts, ddl.ts       INSERT/UPDATE/DELETE, CREATE/DROP + 인덱스 유지
 ├─ catalog/catalog.ts        테이블·컬럼·인덱스 메타데이터 = page 1부터 시작하는 힙
 ├─ record/heap-file.ts       테이블 행 = slotted page 체인, RID = (pageId, slot)
 │  btree/btree.ts            인덱스 = 디스크 B+tree, 항목 = (key 바이트, RID)
 ├─ storage/pager.ts          페이지 캐시(LRU, pin), no-steal 트랜잭션, savepoint, commit, checkpoint, recovery
 ├─ storage/wal.ts            WAL 파일 형식: 프레임 append, scan, reset
 └─ storage/vfs.ts            파일 추상화: NodeVfs(실제 fs) | MemoryVfs + FaultVfs(크래시 시뮬레이션)
```

| 계층 | 핵심 진입점 | 무엇을 숨기는가 |
|---|---|---|
| Database API | `Database.execute` (`src/engine/database.ts:144`), `run` (:189), `wrap` (:124) | 트랜잭션 시작·커밋·롤백, 오류 분류 |
| 파서·분석기 | `parseStatement`, `analyze` | 텍스트 → 타입이 확정된 Bound AST |
| 플래너 | `planScan` (`src/exec/planner.ts:63`), `planSelect` (:98) | 인덱스 사용 여부 |
| 실행기 | `buildOperator`, `collectRows` (`src/exec/operators.ts`) | 행을 하나씩 당겨오는 iterator |
| DML | `executeInsert/Update/Delete` (`src/exec/dml.ts:50/86/139`) | 힙과 모든 인덱스의 동기화 |
| 카탈로그 | `Catalog.load` (`src/catalog/catalog.ts`) | 스키마를 페이지 위 행으로 저장 |
| 힙 | `HeapFile` (`src/record/heap-file.ts:36`) | 가변 길이 행의 배치·이동 |
| B+tree | `BTree` (`src/btree/btree.ts:50`) | 정렬된 키 → RID |
| Pager | `Pager` (`src/storage/pager.ts:88`) | 페이지 = 메모리 버퍼, 트랜잭션, 내구성 |
| WAL | `WalFile`, `scanWal` (`src/storage/wal.ts:161/109`) | 커밋 기록 형식 |
| VFS | `StorageFile`, `Vfs` (`src/storage/vfs.ts`) | 실제 파일 vs 시뮬레이션 파일 |

**의존 방향 규칙**(ARCHITECTURE E.2, T-ARCH-001): 위 계층만 아래를 import한다. 예를 들어 `sql/`은 `storage/`를
import할 수 없어서 언어 한도 상수를 `src/util/limits.ts`로 옮겼다(DEC-004). 이 규칙 덕분에 Pager는 SQL을 전혀
모르고 "페이지 바이트 배열"만 다룬다. 그래서 가장 위험한 내구성 코드를 SQL 없이 페이지 수준에서 먼저
검증할 수 있었다(DESIGN_REVIEW C.1.8: 구현 순서를 WAL·Pager 먼저로 바꾼 이유).

**파일 3개**: `app.db`(데이터 파일, 4096바이트 페이지 배열), `app.db-wal`(WAL), `app.db-lock`(협력적 락).

**페이지 공통 헤더**(16바이트, FORMAT D.1): `type`(오프셋 0), `CRC32`(4~8), `pageId`(8~12).
CRC는 CRC 필드를 0으로 간주하고 4096바이트 전체에 대해 계산한다(`computePageCrc`, `src/storage/page.ts`).
디스크나 WAL에서 읽은 페이지는 항상 `verifyPage`로 CRC → pageId → type 순서로 검증한다.

---

## B. 가장 중요한 이야기 — durability

**한 줄 요약**: "커밋된 것은 사라지지 않고, 커밋되지 않은 것은 디스크에 닿지 않는다."
이를 위해 **no-steal 캐시 + redo-only 페이지 이미지 WAL + 5개의 fsync 순서(F1~F5)** 를 쓴다.

### B.0 먼저 알아야 할 세 가지 결정

| 결정 | 무엇인가 | 왜 (DESIGN_REVIEW C.1.1, C.1.2) |
|---|---|---|
| **no-steal** | 미커밋 트랜잭션이 수정한 페이지(dirty)는 캐시에서 쫓겨나지도, 데이터 파일에 쓰이지도 않는다 | 미커밋 데이터가 디스크에 절대 없으므로 **undo 로그가 필요 없다**. 롤백 = 캐시의 dirty 프레임 버리기. 대가: 트랜잭션 크기가 캐시에 묶인다(`cachePages − 32` 페이지 초과 시 `LimitError TXN_TOO_LARGE`, DC-16) |
| **redo-only 페이지 이미지 WAL** | 커밋할 때 트랜잭션이 바꾼 페이지의 **완성된 4096바이트 이미지 전체**를 WAL에 append한다 | 복구 = "커밋된 이미지를 제자리에 덮어쓰기"뿐. 이미지 전체를 쓰므로 몇 번을 다시 해도 결과가 같다(멱등). no-steal이라 되돌릴(undo) 것이 없으니 redo만으로 충분하다 |
| **WAL read-through** | 읽기 순서: 캐시 → WAL index(`pageId → 최신 커밋 프레임`) → 데이터 파일 (DC-20) | 커밋은 WAL에만 쓰고 데이터 파일은 checkpoint 때만 쓴다. 그 사이 캐시에서 쫓겨난 커밋된 페이지를 데이터 파일에서 읽으면 **옛 버전**을 보게 된다. 그래서 최신 커밋 이미지는 WAL에서 읽어야 한다 |

대안 비교(DESIGN_REVIEW C.1.1): rollback journal은 커밋당 fsync 2~3회에 undo 순서가 까다롭고, shadow paging은
경로 복사·GC 구현량이 가장 크다. redo-only WAL은 **커밋당 fsync 1회**(F4)다.

### B.1 F1~F5 한눈에 (DURABILITY G.4, G.6, G.7, DC-21)

| ID | 위치 | 무엇을 fsync | 왜 필요한가 |
|---|---|---|---|
| F1 | `pager.ts:136` (`Pager.open`) | 부모 디렉터리 | 새로 만든 파일의 **디렉터리 항목**을 내구화. 파일 내용 fsync만으로는 "파일이 존재한다"는 사실이 보장되지 않는다(POSIX). Windows에서는 Node로 불가 → no-op(DC-53) |
| F2 | `wal.ts:196` (`WalFile.reset`) | WAL (truncate 직후) | **truncate(0)를 새 헤더보다 먼저 내구화**. 아래 B.5 참고 |
| F3 | `wal.ts:206` (`WalFile.reset`) | WAL (새 헤더 직후) | 새 헤더가 내구화된 다음에만 프레임을 붙인다 |
| F4 | `wal.ts:231` (`appendTxn`) | WAL (커밋 프레임들 직후) | **커밋 시점(commit point)**. 이것이 끝나야 API가 성공을 반환한다(D1) |
| F5 | `pager.ts:629` (checkpoint), `pager.ts:175` (recovery) | 데이터 파일 | 데이터 파일에 옮긴 이미지가 내구화된 **다음에만** WAL을 지운다(D3) |

코드의 각 줄에 `// FSYNC-Fn` 태그가 있고, `check:docs`가 F1~F5 태그 존재를 검사한다.

### B.2 정상 경로 추적: `INSERT` 하나가 디스크에 닿기까지

예: 자동 커밋 모드에서 `db.execute("INSERT INTO t VALUES (7, 'x')")`.

#### 단계 1 — 트랜잭션과 문장 시작

- 코드: `Database.run` (`database.ts:189`). 명시적 트랜잭션이 아니면 `pager.beginTxn()` → `pager.beginStatement()`.
  그 전에 checkpoint가 예정돼 있으면(`checkpointDue`) 먼저 수행한다(DC-26).
- 메모리: `txnActive = true`, `txnDirty = {}`, `headerBefore = null`, `savepoint = {}`.
- 디스크/WAL: 변화 없음.
- 여기서 crash: 아무 일도 없다. 다음 open은 이전 커밋 상태.

#### 단계 2 — 페이지를 dirty로 만든다

- 코드: `executeInsert` (`dml.ts:50`) → 유일성 검사 → `HeapFile.insert` → `insertEncoded` (`heap-file.ts:78`)
  → 꼬리 페이지를 `pager.pin` 후 **수정 전에** `pager.markDirty` (`pager.ts:372`) → `insertRecord`. 이어서 인덱스마다
  `BTree.insert`. 페이지 할당이 필요하면 `allocate`(`pager.ts:389`)가 Page 0(헤더: pageCount, freelist)을 dirty로 만든다.
- `markDirty`가 하는 일(코드 순서 그대로):
  1. dirty 한도 검사 → 초과 시 `TXN_TOO_LARGE` (상태 변경 전에 던짐)
  2. 문장 savepoint 기록: 이 페이지가 이미 트랜잭션 dirty면 **현재 이미지 복사본**, 아니면 `null` (DC-23)
  3. Page 0이 이 트랜잭션에서 처음 dirty되면 `headerBefore = 현재 이미지 복사` (C절)
  4. `txnDirty.add(id)`, `frame.dirty = true`
- 메모리: 캐시 프레임이 수정됨, CRC는 아직 갱신 안 됨(쓸 때 stamp).
- 디스크/WAL: **변화 없음**(no-steal). dirty 프레임은 LRU 축출 대상이 아니다(`makeRoom`, `pager.ts:307`).
- 여기서 crash: 디스크는 이전 커밋 상태 그대로. 미커밋 변경은 프로세스 메모리와 함께 사라진다 → **원자성**.
- 문장이 실패하면: `rollbackStatement`가 savepoint로 복원(C절). 자동 커밋이면 이어서 `rollbackTxn`.

#### 단계 3 — 문장 종료

- 코드: `pager.releaseStatement()` (`pager.ts:510`). pin이 하나라도 남아 있으면 `InternalError`(I13).
- savepoint 맵을 비운다. 이 시점부터 이 문장은 되돌리지 않는다(트랜잭션 롤백은 여전히 가능).

#### 단계 4 — 커밋: WAL 프레임 쓰기

- 코드: `commitTxn` (`pager.ts:567`) → dirty 페이지를 pageId 오름차순 정렬 → 각 프레임의 CRC stamp(`:579`) →
  `wal.appendTxn(pages)` (`wal.ts:212`).
- `appendTxn`: 프레임마다 `write` 1회. 프레임 = 24바이트 헤더(pageId, flags, salt1, salt2, checksum, reserved) +
  페이지 4096바이트. **마지막 프레임에만 COMMIT 플래그**. 체크섬은 체인:
  `ck_k = CRC32(LE32(ck_{k−1}) ‖ frameHeader[0..16) ‖ page)`, 첫 값은 WAL 헤더 CRC(DC-18).
- 디스크/WAL: 프레임들이 OS에 쓰였지만 **아직 fsync 전**.
- 여기서 crash(F4 전):
  - 프레임 일부만 남거나(torn), 마지막 COMMIT 프레임이 없거나, 체크섬이 끊기면 → 복구 스캔이 그 트랜잭션을 **통째로 버린다**.
  - OS가 프레임을 전부(COMMIT 포함) 디스크에 남겼다면 → 그 트랜잭션이 **적용될 수도 있다**.
  - 둘 다 허용된다. API가 아직 성공을 반환하지 않았기 때문이다("in-flight" 트랜잭션, 크래시 오라클이 둘 다 허용).
  - 절대 일어나지 않는 일: 트랜잭션의 **일부만** 적용되는 것. COMMIT 프레임까지 체인이 이어진 것만 인정하기 때문이다.

#### 단계 5 — F4 (commit point)

- 코드: `this.file.sync(); // FSYNC-F4 (commit point)` (`wal.ts:231`).
- 이 fsync가 성공하면 COMMIT 프레임까지 내구화. 그 다음에만 `walIndex`를 갱신하고 프레임을 clean으로 표시(`pager.ts:594-597`),
  `endTxn()`.
- 실패하면: `StorageError IO_COMMIT_UNKNOWN`으로 감싸고 핸들을 **FAILED**로 만든다(`pager.ts:590`). 커밋됐는지 알 수
  없으므로 더 이상 쓰지 않는다. 재오픈하면 S 또는 S⁺ 중 하나(T-FAIL-001). fsync 실패 후 재시도는 성공처럼 보여도
  믿을 수 없다(DC-49의 "fsyncgate").
- 여기서 crash(F4 성공 후, API 반환 전): 트랜잭션은 내구화됐으므로 재오픈하면 **반드시 보인다**. 호출자는 성공 응답을
  못 받았지만 이것도 in-flight 허용 범위다.

#### 단계 6 — API 반환

- `run`이 결과를 반환. 이 순간부터 "acknowledged commit". 이후 어떤 crash에서도 사라지면 안 된다(D1).
- 메모리: 바뀐 페이지는 캐시에 **clean**으로 남고, 최신 이미지 위치는 `walIndex`에 있다.
- 데이터 파일: **아직 옛 내용**. 그래서 B.0의 read-through가 필요하다.
- 커밋 후 WAL 프레임 수가 `walAutoCheckpointFrames`(기본 1000) 이상이면 `checkpointDue = true`.
  checkpoint는 **다음 `execute()` 시작 시점**에 수행한다. 그래서 checkpoint가 실패해도 이미 성공한 커밋을 실패로
  보고하지 않는다(DC-26, 리뷰 REVIEW-ERR-001에서 확인).

#### 단계 7 — checkpoint: 데이터 파일로 옮기기

`checkpoint` (`pager.ts:607`), 트랜잭션 중에는 거부(`TXN_ACTIVE`).

| 순서 | 동작 | 이 직후 crash하면 |
|---|---|---|
| 7-1 | `walIndex`의 페이지마다 최신 커밋 이미지를 데이터 파일 `id × 4096`에 write (캐시에 있으면 clean 프레임, 없으면 WAL 프레임) | 데이터 파일에 일부·찢긴 페이지가 있어도 WAL이 온전하므로 복구가 전부 다시 덮어쓴다 |
| 7-2 | **F5**: `data.sync()` (`pager.ts:629`) | 데이터 파일이 내구화됨. WAL도 아직 온전 → 복구가 같은 이미지를 다시 써도 결과 동일 |
| 7-3 | WAL `truncate(0)` | truncate가 남았든 안 남았든 데이터는 이미 F5로 안전 |
| 7-4 | **F2**: WAL fsync (`wal.ts:196`) | WAL은 빈 상태로 내구화 |
| 7-5 | 새 헤더 write (checkpointSeq+1, 새 salt) | 헤더가 찢겨도 파일 크기 ≤ 48 → "빈 WAL"로 처리(DC-22) |
| 7-6 | **F3**: WAL fsync (`wal.ts:206`) | 새 세대의 빈 WAL |
| 7-7 | `walIndex.clear()` | — |

checkpoint 중 어떤 오류든 FAILED(`pager.ts:632-634`).

### B.3 F5 전에 WAL을 지우면 왜 위험한가

데이터 파일 write는 fsync 전까지 OS 캐시에만 있을 수 있다. 그 상태에서 WAL을 truncate하고 truncate가 먼저
디스크에 반영된 뒤 전원이 나가면, 데이터 파일의 새 이미지는 사라졌는데 WAL도 비어 있다. 그러면
**acknowledged commit이 사라진다**. F5 → truncate 순서가 이것을 막는다(D3). 구현 단계에서 "checkpoint fsync
순서 역전" 변이를 crash matrix가 잡았다(PROGRESS P14).

### B.4 Recovery 추적: `crash → reopen`

`Pager.open` (`pager.ts:117`) → `recoverOrCreate` (`:151`). DURABILITY G.7 pseudocode와 줄 단위로 일치한다(리뷰 §10).

1. **락**: `vfs.acquireLock` → 이미 열려 있으면 `DB_LOCKED`.
2. **F1**: 데이터 파일이나 WAL을 새로 만들었으면 디렉터리 fsync.
3. **WAL 헤더 읽기** (`readWalHeader`, `wal.ts:79`): 유효 | 무효 ∧ 크기 ≤ 48(= 빈 WAL) | 무효 ∧ 크기 > 48(→ `WAL_HEADER_INVALID`).
4. **스캔** (`scanWal`, `wal.ts:109`): 프레임 0부터 다음 중 하나면 **중단**:
   남은 바이트 < 4120, salt 불일치, 체크섬 체인 불일치, 예약 필드/플래그 비정상(DC-19).
   프레임은 `pending`에 쌓다가 **COMMIT 플래그를 만나면** `committed`로 옮긴다. 그래서 COMMIT 없는 꼬리는 버려진다.
   체인은 맞는데 페이지 CRC가 틀리면 `WAL_FRAME_INVALID`(쓰기 버그 신호).
5. **커밋 이미지가 있으면**: 데이터 파일 헤더가 읽히는데 dbId가 다르면 `WAL_MISMATCH`. 아니면 페이지마다
   **최신 커밋 이미지**를 데이터 파일에 write → **F5**(`pager.ts:175`) → 헤더 다시 읽기·dbId 확인.
6. **데이터 파일 크기 0이고 커밋 없음** → 새 DB 생성(bootstrap, DC-63): WAL reset → Page 0·Page 1(카탈로그 head)를
   하나의 트랜잭션으로 커밋(F4) → checkpoint. 생성 도중 어느 지점에서 crash해도 재오픈하면 빈 DB(T-CRASH-P03).
7. **WAL reset**: WAL이 "유효 헤더 48바이트 ∧ dbId 일치"가 아니면 `WalFile.reset`(F2, F3).
   → open이 끝나면 WAL은 항상 비어 있다. 그래서 한 세션의 프레임 위치는 한 번씩만 쓰인다(D4).
8. `FILE_TRUNCATED` 검사, Page 0을 읽어 검증 후 캐시에 상주.

**왜 멱등(idempotent)인가**: 복구가 하는 쓰기는 "커밋된 **전체 페이지 이미지**를 제자리에 쓰기"뿐이고,
F5 전에는 WAL을 건드리지 않는다(D6). 복구 도중 crash하면 WAL이 그대로라 다음 복구가 같은 이미지를 다시 쓴다.
같은 바이트를 두 번 쓰는 것은 한 번 쓰는 것과 같다. 증분(delta) 로그였다면 두 번 적용이 문제가 됐을 것이다.
검증: T-CRASH-P02, T-CRASH-002(P-DURABLE/P-ALL), T-CRASH-006(찢긴 쓰기, 무작위 부분 반영, 이중 크래시).

### B.5 F2가 "실제로" 필요한 이유

F2는 F3가 같은 파일을 곧 fsync하므로 군더더기처럼 보인다. 하지만 F2가 없으면 이런 일이 생긴다.

1. truncate(0)가 아직 내구화되지 않은 상태에서 새 헤더 write가 시작된다.
2. 헤더 write 도중 crash가 나서 **헤더 앞부분만** 디스크에 남는다(torn). truncate는 사라진다.
3. 재오픈하면 파일에는 찢긴(무효) 헤더 + **옛 프레임들**이 그대로 있다. 크기 > 48이다.
4. DC-22 규칙상 "무효 헤더 ∧ 크기 > 48" = `CorruptionError WAL_HEADER_INVALID` → **DB를 열 수 없다**.

F2가 있으면 truncate가 먼저 내구화되므로, 헤더가 찢겨도 파일 크기 ≤ 48 → "빈 WAL"로 안전하게 처리된다.

독립 리뷰의 변이 M3(F2 제거)에서 실제로 T-CRASH-P03이 `WAL header is invalid but the WAL holds 8288 bytes`로
실패했다. 같은 변이에서 T-CRASH-004(fsync 순서 패턴 검사)도 실패했다. T-WAL-003/004도 실패했는데, 이 둘은
op 번호를 하드코딩한 테스트라서 연산 하나가 빠지자 crash 지점이 밀린 결과다. 즉 **의미 있는 검출은
T-CRASH-P03과 T-CRASH-004**이고, WAL 단위 테스트의 실패는 "우연한" 검출이다. 변이 테스트 결과를 읽을 때는
"무엇이 왜 실패했는지"를 구분해야 한다는 교훈이다.

### B.6 COMMIT 플래그와 체크섬 체인이 하는 일

- **COMMIT 플래그**: "이 프레임까지가 한 트랜잭션"이라는 경계. 플래그가 없는 프레임은 다음 COMMIT이 나올 때까지
  미확정이다. 트랜잭션의 원자성을 WAL 형식이 표현하는 방법이다.
- **체크섬 체인**: 각 프레임이 이전 프레임의 체크섬을 포함하므로, 중간 프레임이 찢기거나 빠지면 그 뒤가 전부
  무효가 된다. 첫 값이 헤더 CRC(salt 포함)이므로 이전 세대의 프레임은 새 헤더 아래에서 체인이 맞지 않는다.
- **한계**: WAL **중간**의 비트 플립도 체인을 끊으므로 "찢긴 꼬리"와 구분할 수 없다. 그 뒤의 커밋은 조용히
  버려진다(DC-19, LIMITATIONS). 결과는 일관된 이전 상태지만 데이터 손실이다. 해결하려면 프레임별 트랜잭션 표식이
  있는 형식 v2가 필요하다(FUTURE).

### B.7 내구성 주장의 정확한 범위

검증된 것: **단일 프로세스**에서, `MemoryVfs`/`FaultVfs`가 모델링한 장애(fsync되지 않은 쓰기의 임의 유실, 쓰기의
접두사 찢김, 미동기화 연산의 무작위 부분 반영, 디렉터리 fsync 전 파일 생성 유실)에 대해 모든 쓰기·fsync·truncate
지점에서 crash해도 acknowledged commit이 남고, 부분 트랜잭션이 보이지 않으며, 재오픈 후 `integrityCheck`가 통과한다.

검증되지 않은 것: 실제 전원 차단, 모델과 다른 OS/디스크 캐시 동작(섹터 순서 뒤바뀜 등), Windows 디렉터리
내구성, 다중 프로세스, POSIX 파일 시스템(Linux/macOS에서 실행한 적 없음). → J절.

---

## C. Page 0과 rollback

**한 줄 요약**: Page 0(파일 헤더)은 캐시에서 절대 빠지지 않으므로, 롤백할 때 "버리기" 대신
`headerBefore` 이미지로 **제자리 복원**한다. 이것이 rev1에서 확정한 규칙이다.

### C.1 Page 0이 무엇이고 왜 항상 상주하는가

Page 0에는 magic, 버전, `pageCount`, `freelistHead`, `freelistCount`, `catalogRoot`, `dbId`가 있다(FORMAT D.2).
`pageCount`는 거의 모든 `pin`의 범위 검사에, freelist는 모든 할당·해제에 쓰인다. 그래서 Page 0은 open할 때
읽어서 캐시에 넣고(`pager.ts:201-205`) **LRU 축출 대상에서 제외**한다(`makeRoom`이 id 0을 건너뜀, `pager.ts:311`).
Pager의 `pageCount` getter는 캐시의 Page 0을 직접 읽는다(`header0()`).

### C.2 rev1에서 무엇이 모호했나

구현 전 설계(rev0)에는 두 문장이 함께 있었다.

- G.1: "Page 0은 항상 resident"
- G.5: "statement/transaction rollback은 dirty 프레임을 캐시에서 제거한다"

Page 0이 dirty일 때 롤백하면 두 규칙이 충돌한다. 제거하면 "항상 상주"가 깨지고, 제거하지 않으면 롤백이 안 된다.
rev1 정합성 점검에서 **"Page 0은 제거하지 않고 트랜잭션이 처음 Page 0을 dirty로 만들 때 저장한 이미지
(`txn.headerBefore`)로 제자리 복원한다"**로 하나로 확정했다(DESIGN_REVIEW 개정 이력, DC-23, DC-24).
결과 의미("롤백 = 마지막 커밋 상태")는 그대로이고 모순만 사라졌다. 구현 전에 잡은 설계 결함의 예다.

### C.3 코드 흐름

- **캡처** (`markDirty`, `pager.ts:384`): `if (id === 0 && !this.txnDirty.has(0)) this.headerBefore = copy`.
  트랜잭션에서 **처음** dirty될 때 한 번만 캡처한다. 이때 캐시의 Page 0은 마지막 커밋 이미지다.
  dirty 한도 검사 **다음**에 캡처하므로 `TXN_TOO_LARGE`로 거부된 markDirty는 흔적을 남기지 않는다.
- **문장 savepoint** (`pager.ts:381-383`): 문장 안에서 처음 dirty되는 페이지마다 `savepoint[id]` = (이미 트랜잭션
  dirty면 현재 이미지 복사본, 아니면 `null`).
- **문장 롤백** (`rollbackStatement`, `pager.ts:517`):
  - 복사본이 있으면 → 그 이미지로 복원, **dirty 유지**(앞 문장의 변경이 남아 있으므로).
  - `null`인데 Page 0이면 → `headerBefore`로 복원, clean, `txnDirty`에서 제거, `headerBefore = null`.
  - `null`인데 다른 페이지면 → 캐시에서 제거(다음 읽기는 WAL 또는 데이터 파일의 커밋 이미지).
- **트랜잭션 롤백** (`rollbackTxn`, `pager.ts:542`): dirty 페이지 중 Page 0은 `headerBefore`로 복원 후 clean,
  나머지는 제거. 헤더도 한 페이지이므로 `pageCount`와 freelist가 자동으로 원래대로 돌아간다(DC-24).
- **커밋** (`commitTxn`): Page 0도 다른 페이지처럼 CRC stamp → WAL 프레임 → clean. `endTxn()`이 `headerBefore = null`.

### C.4 경로별 상태 (리뷰 REVIEW-P0-001에서 바이트 단위로 검증)

| 경로 | 이후 Page 0 바이트 | dirty | txnDirty에 0 | headerBefore |
|---|---|---|---|---|
| 자동 커밋 성공 | CRC stamp됨 = WAL 이미지 | 아니오 | 아니오 | null |
| 자동 커밋 실패(Page 0을 dirty로 만든 뒤) | 문장 전과 동일 | 아니오 | 아니오 | null |
| 명시적: S1이 Page 0 dirty, **S2가 다시 수정하다 실패** | S1 직후 이미지 | **예** | 예 | 트랜잭션 전 이미지 |
| 명시적: S1은 Page 0 안 건드림, S2가 처음 dirty 후 실패 | 트랜잭션 전 이미지 | 아니오 | 아니오 | null (S3가 다시 캡처) |
| ROLLBACK | 트랜잭션 전 이미지 | 아니오 | 아니오 | null |

셋째 줄이 핵심이다. S2 입장에서 Page 0은 "이미 트랜잭션 dirty"이므로 savepoint에 **S1 직후 복사본**이 기록된다.
그래서 S2 실패 시 S1의 변경(예: CREATE TABLE이 늘린 pageCount)은 남고, `headerBefore`(트랜잭션 전 이미지)는
나중의 ROLLBACK을 위해 그대로 보존된다. 이 테스트를 만들 때 실패를 유도하는 문장으로 `CREATE UNIQUE INDEX`
(인덱스 루트를 할당해 Page 0을 dirty로 만든 뒤 중복 키로 실패)를 사용했다.

**테스트 연결**: T-PGR-007(트랜잭션 롤백, Page 0 상주), T-PGR-008(문장 롤백의 두 경우),
T-PGR-012(무작위 페이지 트랜잭션 vs Map 모델), `tests/review/page0.review.test.ts`.
구현 단계 변이: "Page 0 제자리 복원 제거" → T-PGR-008/012가 검출(PROGRESS P4).

**파생 캐시 주의**(DC-25): 카탈로그 캐시처럼 페이지에서 파생된 메모리 상태는 **모든 롤백 후 무효화**한다
(`database.ts`의 `catalogCache = null`). 그렇지 않으면 ROLLBACK된 CREATE TABLE이 메모리에 남는다.

---

## D. Heap / Record / RID

**한 줄 요약**: 행은 slotted page에 저장되고, slot 번호로 간접 참조하므로 페이지 안에서 바이트를 옮겨도 RID가
변하지 않는다. 페이지를 옮기면 새 RID가 되므로 모든 인덱스를 고쳐야 한다.

### D.1 행 인코딩 (`src/record/row-codec.ts`, FORMAT D.4)

`u8 컬럼 수` + NULL 비트맵(⌈n/8⌉바이트, LSB부터) + NULL이 아닌 값을 컬럼 순서로: INTEGER = i64 LE 8바이트,
BOOLEAN = u8, TEXT = u16 길이 + UTF-8. 디코더는 컬럼 수, 남는 비트맵 비트, 잘린 필드, 안전 범위 밖 정수,
1보다 큰 BOOLEAN, 잘못된 UTF-8, 꼬리 바이트를 모두 `RECORD_MALFORMED`로 거부한다.

### D.2 slotted page (`src/record/heap-page.ts`, FORMAT D.3)

```text
0        16          32                                     recordStart          4096
| 공통헤더 | 힙 헤더 | slot[0] slot[1] ... →     (빈 공간)     ← ... rec1 rec0 |
           slotCount(16) recordStart(18) nextPage(20) tailPage(24) fragmentedBytes(28)
```

- **slot directory**: slot마다 4바이트 (offset u16, length u16). 앞에서 뒤로 자란다.
- **레코드 영역**: 끝에서 앞으로 자란다. `recordStart`가 경계.
- **tombstone**: 삭제된 slot = (0, 0). 마지막 slot들이 tombstone이면 `slotCount`를 줄인다(`deleteRecord`, `:173`).
  새 삽입은 **가장 낮은 번호의 tombstone**을 재사용한다(`insertRecord`, `:129`).
- **fragmentation**: 삭제·축소로 생긴 구멍은 `fragmentedBytes`로 센다. 불변식: `fragmentedBytes = 4096 − recordStart − Σ(살아있는 길이)`(I6).
- **compaction** (`compact`, `:103`): 살아있는 레코드를 끝에서부터 다시 채운다. **slot 번호는 그대로** → RID 불변.
  연속 공간이 부족하지만 총 공간(연속 + fragmented)이 충분할 때만 실행한다.
- 최대 행 크기: 4096 − 32 − 4 = **4060바이트**(MAX_ROW_BYTES). TEXT는 4000바이트 이하.

### D.3 RID와 힙 체인 (`src/record/heap-file.ts`)

- RID = (pageId u32, slot u16) (DC-27).
- 테이블 = head 페이지부터 `nextPage`로 이어진 체인. head의 `tailPage`가 마지막 페이지를 가리킨다.
- **삽입 위치** (DC-61, `insertEncoded`, `:78`): 꼬리 페이지에만 시도하고, 공간이 없으면 새 페이지를 할당해 체인
  끝에 연결한다. 앞쪽 페이지의 빈 공간은 같은 페이지의 UPDATE·compaction으로만 재사용된다(J절의 한계).

### D.4 행 이동 예: UPDATE가 행을 키운다

`UPDATE t SET pad = '<1500바이트>' WHERE id = 3`, 행 3은 RID (5, 2)에 있고 page 5는 꽉 차 있다고 하자.

1. `HeapFile.update(rid=(5,2), newValues)` (`heap-file.ts:118`): 새 레코드를 인코딩.
2. page 5를 pin, `markDirty`. `canUpdate(p, 2, newLen)` (`heap-page.ts:144`):
   `newLen ≤ oldLen` 또는 연속 공간 ≥ newLen 또는 (총 여유 + oldLen) ≥ newLen이면 제자리 → 같은 RID.
3. 셋 다 아니면 **이동**: `deleteRecord(p, 2)` → slot 2는 tombstone. 그리고 `insertEncoded`로 꼬리 페이지
   (예: page 9)에 삽입 → 새 RID (9, 0). page 9도 부족하면 새 페이지를 할당하고 체인·`tailPage`를 갱신한다.
4. `update`는 **새 RID를 반환**한다. 호출자(`executeUpdate`)가 이 테이블의 **모든 인덱스**에서
   (key, (5,2))를 지우고 (key, (9,0))을 넣는다. 값이 안 바뀐 컬럼의 인덱스도 마찬가지다(F절).
5. 문장이 실패하면 savepoint 롤백으로 page 5, page 9, Page 0, 인덱스 페이지가 모두 문장 전 상태로 돌아간다.

리뷰에서 확인한 미묘한 점: 꼬리 페이지에 있던 행이 이동하면, 자기 삭제로 생긴 공간 + slot 4바이트로도 들어가지
않으므로 **같은 페이지로 되돌아오지 않는다**. 그래서 이동한 행은 새 꼬리 페이지로 간다.

### D.5 freelist (`pager.ts:389` `allocate`, `:433` `free`)

DROP TABLE/INDEX가 페이지를 반납하면 `free`가 페이지를 FREE 타입으로 초기화하고, 다음 포인터에 현재 head를
넣고, Page 0의 `freelistHead`/`freelistCount`를 갱신한다. `allocate`는 freelist head를 먼저 쓰고, 비어 있으면
`pageCount`를 늘린다. 둘 다 Page 0을 dirty로 만들기 때문에 롤백 시 freelist도 자동 복원된다.
I4가 순환, 범위, 타입, 개수를 검사한다. 파일은 줄어들지 않는다(VACUUM 없음).

---

## E. B+tree

**한 줄 요약**: 키를 "바이트 비교 = 값 비교"가 되도록 인코딩하고, 항목 (key, RID)를 정렬해 저장하는 디스크 B+tree.
루트 페이지 ID는 생성부터 DROP까지 바뀌지 않는다.

### E.1 키 인코딩 (`encodeKey`, `src/btree/key-codec.ts:12`, FORMAT D.6)

| 타입 | 인코딩 | 이유 |
|---|---|---|
| INTEGER | 8바이트 big-endian, **부호 비트 반전** | 2의 보수를 그대로 쓰면 음수(최상위 비트 1)가 양수보다 바이트상 커진다. 부호 비트를 뒤집으면 −1 = `7F FF…`, 0 = `80 00…`, 1 = `80 00…01`처럼 바이트 순서가 수 순서와 같아진다 |
| BOOLEAN | `00` / `01` | FALSE < TRUE |
| TEXT | UTF-8 그대로(≤ 512바이트) | UTF-8 바이트 순서 = 코드 포인트 순서. JS 문자열 `<`는 UTF-16 코드 단위 비교라 이모지(서로게이트)와 U+FF71 같은 문자에서 순서가 다르다. 그래서 텍스트 비교는 모두 `compareText`(UTF-8 바이트)로 한다(DC-39) |

`compareBytes`는 사전식이고 **접두사가 더 작다**: `'' < 'a' < 'aa' < 'ab' < 'b'`.
NULL은 색인하지 않는다(DC-28). 그래서 UNIQUE 인덱스에 NULL이 여러 개 있어도 된다.

### E.2 unique / non-unique와 `(key, rid)`

`compareEntry` (`key-codec.ts:36`): 키 바이트를 먼저 비교하고, **비유일 인덱스만** 동률일 때 RID(pageId, slot)를 비교한다.

- **non-unique에서 키만 비교하면 안 되는 이유**: 같은 키가 수백 개면 항목들이 서로 "같다". 그러면 특정 항목
  (key, rid)을 삭제할 때 어느 것을 지울지 정할 수 없고, 분할 separator가 같은 키를 양쪽에 나누어 탐색 위치가
  모호해진다. RID를 두 번째 키로 쓰면 모든 항목이 유일해진다. 삭제는 정확히 그 항목을 찾고, 범위 탐색은
  (key, MIN_RID)로 seek한 뒤 오른쪽으로 걸으면 된다.
- **unique**: 키만 비교한다. 같은 키는 하나뿐이므로 `findUnique`가 유일성 검사에 쓰인다.

### E.3 탐색과 분할 (`src/btree/btree.ts`)

- **descend** (`:114`): 내부 노드에서 `route` = "target < separator인 첫 셀의 자식, 없으면 rightPtr".
  지나온 경로를 페이지 ID로 기록한다(pin을 들고 내려가지 않는다, DC-17).
- **leaf split** (`insert`, `:143`): 새 항목을 포함한 전체 항목을 바이트 크기 절반 지점(`splitPoint`)에서 나눈다.
  오른쪽 새 리프가 `[m..]`을 갖고, separator = `entries[m]`(전체 항목), 리프 연결은
  `왼쪽 → 새 오른쪽 → 원래 다음`으로 잇는다.
- **부모 삽입** (`insertIntoParent`, `:199`): `left`를 가리키던 포인터 자리에 `(sep, left)` 셀을 넣고, 그 다음
  포인터를 `right`로 바꾼다. 부모도 가득 차면 **internal split**: 가운데 셀을 위로 올리고(promote), 그 셀의 자식이
  왼쪽 노드의 rightPtr가 된다. 이를 재귀로 반복한다.
- **root split** (`splitRoot`, `:184`, 내부 루트는 `:225-239`): 루트 내용을 새 페이지 L, R로 옮기고, 루트 페이지
  자체는 `[(sep, L)] + rightPtr R`인 내부 노드로 다시 초기화한다. **루트 페이지 ID는 그대로**다.
- **leaf links**: 리프마다 rightPtr가 다음 리프를 가리킨다. 범위 스캔(`scan`, `:274`)은 시작 리프만 찾은 뒤
  링크를 따라 걷는다. 빈 리프는 건너뛰고, 상한을 넘으면 멈춘다. 배타적 하한이면 같은 키를 건너뛴다.

### E.4 왜 fixed root인가 (DC-29)

인덱스 루트 페이지 ID는 카탈로그 행(`root_page`)에 저장된다. 카탈로그 행은 **삽입·삭제만 하고 갱신하지 않는다**.
그래서 RID가 안정적이고, 카탈로그 객체가 그 RID를 캐시한다(`catalog.ts`). 루트가 분할될 때마다 루트 ID가
바뀐다면 그때마다 카탈로그 행을 갱신해야 하고, 평범한 INSERT 문장이 카탈로그(스키마)를 건드리게 된다.
루트를 고정하면 루트 분할은 B+tree 내부 일로 끝나고, 카탈로그는 DDL에서만 바뀐다. 대가는 루트 분할 때
페이지 하나를 더 복사하는 정도다.

### E.5 lazy deletion (DC-30, DESIGN_REVIEW C.1.4)

삭제는 리프의 항목만 지운다(`delete`, `:255`). separator와 빈 리프는 남고 트리는 줄지 않는다.
병합·재분배는 구현량과 버그 표면이 분할의 2배 이상이라 범위에서 뺐다. 정확성에는 문제가 없다. 라우팅 규칙이
같으므로 키는 항상 원래 들어간 리프에서 찾아지고, 스캔은 빈 리프를 건너뛴다. 벤치마크 B10(삭제 50% + 재삽입
10회)에서 페이지 수가 +31% 늘고 7회차부터 평형이 되어, 번복 조건(10배)에 한참 못 미쳤다.

### E.6 검증

T-KEY-001/002(인코딩 순서), T-BT-001~007, T-IDX-*, I8~I11 integrityCheck, 리뷰의 독립 모델 테스트
REVIEW-BT-001(높이 3까지, 접두 키·빈 키·512바이트 키·중복·lazy 삭제·롤백).

---

## F. UPDATE가 어려운 이유

예제: 테이블 `t(id INTEGER PRIMARY KEY, g INTEGER, pad TEXT)`, 인덱스 `mdb_pk_t(id)`(유일)와 `tg(g)`(비유일).

```sql
UPDATE t SET id = id + 1, pad = '<큰 값>' WHERE g >= 0
```

`executeUpdate` (`src/exec/dml.ts:86`)의 순서:

1. **대상 materialize** (`collectTargets`, `:81`): 플랜(여기서는 `tg` IndexScan + Filter)을 **끝까지 실행해**
   `(rid, 기존 행)` 목록을 메모리에 모은다(DC-62). 아직 아무것도 바꾸지 않았다.
   - **Halloween problem**: 스캔하면서 바로 갱신하면, 갱신된 행이 스캔 앞쪽(인덱스의 뒤쪽 키, 또는 꼬리 페이지)으로
     이동해 **다시 대상이 되는** 일이 생긴다. 예를 들어 `SET g = g + 4`를 `tg`로 스캔하며 적용하면 같은 행이 계속
     다시 나타날 수 있다. 행 이동도 같은 문제를 만든다(이동한 행이 꼬리 페이지에 다시 나타남).
     먼저 다 모으면 각 행은 정확히 한 번 갱신된다. 검증: T-EXEC-004, 리뷰 REVIEW-SQL-001(200행 성장 UPDATE).
2. **새 행 전부 계산**: SET 식은 **옛 행**을 본다(F.6). 모든 새 행에 대해 NOT NULL, 인코딩 크기, 인덱스 키 크기를
   먼저 검사한다. 하나라도 실패하면 아무것도 쓰지 않은 상태로 오류를 낸다.
3. **문장 수준 유일성** (DC-31): 바뀐 유일 인덱스마다
   (a) 새 키끼리 중복인지(`seen` 집합), (b) 새 키를 가진 기존 항목이 **대상이 아닌** 행인지(`findUnique` → owner가
   대상 RID 집합에 없으면 위반)를 본다. 그래서 `id = id + 1`(1,2,3 → 2,3,4)은 성공한다. 행 단위로 바로 검사했다면
   1→2로 바꾸는 순간 아직 바뀌지 않은 2와 충돌해 실패했을 것이다.
4. **힙 적용**: 대상마다 `heap.update` → 새 RID(제자리면 같은 RID).
5. **인덱스 적용**: 인덱스마다, 컬럼이 바뀌었거나 RID가 바뀐 행에 대해
   - **먼저 옛 항목 (oldKey, oldRid)을 전부 삭제**하고,
   - **그 다음 새 항목 (newKey, newRid)을 전부 삽입**한다.
   삭제와 삽입을 행마다 번갈아 하면, 행 A의 새 키가 아직 지워지지 않은 행 B의 옛 키와 잠시 같아져
   유일 B+tree가 "중복 항목" invariant로 실패할 수 있다. 전부 지운 다음 넣으면 중간 상태 충돌이 없다.
   컬럼이 안 바뀌고 RID도 같으면 그 인덱스는 건드리지 않는다.
6. **rollback**: 1~5 어디서든 오류가 나면 `Database.run`이 `rollbackStatement`를 호출해 이 문장이 dirty로 만든
   힙·인덱스·Page 0 페이지를 모두 문장 전 이미지로 되돌린다. 그래서 "힙은 바뀌었는데 인덱스는 안 바뀐" 상태가
   커밋될 수 없다.

**실제 사건**: 구현 단계(P13)에서 "행 이동 시 인덱스 갱신 생략" 변이를 넣었을 때 무작위 모델 테스트가 처음에는
잡지 못했다. 생성기가 만드는 행이 작아서 **행이 페이지를 옮기는 일이 거의 없었기 때문**이다. 생성기에 6% 확률로
300~650바이트 TEXT를 넣자 검출됐다(H절).

---

## G. Planner / Executor

**한 줄 요약**: 규칙 기반 플래너가 인덱스로 후보를 줄이고, WHERE 전체는 항상 Filter로 다시 검사한다.
실행은 Volcano iterator(`open/next/close`)다.

### G.1 연산자 (SPEC F.9, `src/exec/operators.ts`)

| 연산자 | 동작 |
|---|---|
| SeqScan | 힙 체인을 따라 살아 있는 slot의 행 **복사본**을 하나씩 반환. `next()` 사이에 pin을 들고 있지 않음 |
| IndexScan | B+tree를 하한에 seek → 항목마다 RID로 힙 행 조회(없으면 `INDEX_HEAP_MISMATCH`) → 상한을 넘으면 끝 |
| Filter | 술어가 **TRUE**인 행만 통과(NULL/UNKNOWN은 탈락) |
| Sort | 자식 전체를 모아 안정 정렬. NULL은 가장 작음(ASC면 앞, DESC면 뒤, DC-34) |
| Limit | `LIMIT 0`이면 자식을 열지 않음. OFFSET만큼 버린 뒤 n개 |
| Project | 선택 컬럼만 새 배열로 |

SELECT 플랜 모양: `Project → Limit → Sort → Filter → SeqScan | IndexScan`(F.8 규칙 7).
Volcano의 장점은 상위 연산자가 멈추면 하위 스캔도 멈춘다는 것이다(LIMIT). Sort와 DML 대상 수집은 명시적인
materialize 지점이다. `EXPLAIN SELECT ...`로 이 트리를 문자열로 볼 수 있다.

### G.2 sargable 술어와 인덱스 선택 (`planner.ts:30` `sargable`, `:63` `planScan`)

- WHERE를 최상위 AND로 쪼갠다(OR, NOT 안으로는 들어가지 않는다).
- **sargable**: `col op 상수` 또는 `상수 op col`(연산자를 뒤집어 정규화), `op ∈ {=, <, <=, >, >=}`, 상수는 NULL이
  아닌 리터럴 또는 `-정수리터럴`. `<>`, IS NULL, 컬럼끼리 비교, 그 밖의 식은 제외.
- **DEC-006**: UTF-8 512바이트를 넘는 TEXT 리터럴은 sargable이 아니다. 키로 인코딩하면 `KEY_TOO_LARGE`가 나서
  플래너 자신이 인덱스 유무에 따라 오류/성공을 가르게 되기 때문이다. 그런 값은 인덱스에 있을 수도 없다.
- 우선순위: `=`가 있는 유일 인덱스 > `=`가 있는 비유일 인덱스 > 범위. 동률이면 인덱스 이름순.
- 범위 계산: 하한은 가장 큰 값, 상한은 가장 작은 값, 같은 값이면 배타가 이긴다. 모순(`id > 5 AND id < 3`)이면 빈 범위.

### G.3 왜 인덱스를 써도 WHERE 전체를 Filter로 남기는가 (DC-70)

1. **정확성의 단일 근거**: 결과의 정확성은 Filter 하나만 책임지고, 인덱스는 "후보를 줄이는 최적화"로 한정한다.
   IndexScan의 범위 계산(포함/배타, 정규화, 타입)에 버그가 있어도 **후보가 넉넉하기만 하면** 결과는 틀리지 않는다.
2. **복합 조건**: `g = 2 AND id > 0 AND pad IS NULL`에서 인덱스는 하나의 컬럼만 쓰므로 나머지 조건은 어차피
   검사해야 한다.
3. **결과**: SeqScan과 IndexScan이 같은 행을 반환한다. T-DIFF-001(`forceSeqScan` 비교)과 리뷰의 31개 술어
   비교(REVIEW-SQL-001)로 검증했다.

부작용도 있다. 범위 계산에서 "같은 값이면 배타가 이긴다"를 거꾸로 만드는 변이는 **SQL 결과로는 드러나지 않는다**
(Filter가 가려 준다). EXPLAIN 출력이나 B+tree 단위 테스트(T-BT-004)로만 보인다. 리뷰 변이 M4가 그 예다.

### G.4 DC-43: 플랜에 따라 달라지는 런타임 오류

```sql
-- t: (1, x=1), (2, x=9007199254740991), id는 PK
SELECT id FROM t WHERE x * 2 > 0 AND id = 1
```

- IndexScan(PK, `id = 1`): 행 1만 평가 → `1*2 > 0` 참 → 결과 `[[1]]`.
- SeqScan(`forceSeqScan`): 행 2도 평가 → `x * 2`가 안전 정수 범위를 넘음 → `LimitError INTEGER_OVERFLOW`.

DC-43은 "실제로 평가된 행·식에서만 오류, 어떤 행이 평가되는지는 플랜에 따라 다를 수 있다"고 명시한다.
그래서 이것은 버그가 아니라 정의된 의미다(PostgreSQL 같은 실제 DB도 비슷하다). DEC-006과의 차이는 다음과 같다
(DEC-007에서 명확화).

- 플래너가 **스스로** 만드는 오류(리터럴 인코딩)는 인덱스 유무에 따라 달라지면 안 된다.
- 행 평가 오류는 달라질 수 있다.

무작위 생성기는 이 때문에 WHERE에 산술을 넣지 않는다(J.4).

---

## H. Testing strategy

**한 줄 요약**: 테스트 개수보다 **종류**가 중요하다. 종류마다 잡는 버그가 다르고, 서로가 놓친 것을 잡았다.

### H.1 종류별로 무엇을 잡는가

| 종류 | 예 | 무엇을 잡는가 | 무엇을 못 잡는가 |
|---|---|---|---|
| unit | T-PAGE-*, T-HP-*, T-BT-*, T-WAL-*, T-PGR-* | 한 모듈의 경계값, 형식, 알고리즘 단계(예: 분할 후 리프 연결) | 계층 사이 상호작용 |
| integration | T-EXEC-*, T-IDX-*, golden SQL(T-GOLD-001) | SQL에서 디스크까지 끝까지 연결된 동작, 오류 코드·위치 | 사람이 떠올리지 못한 조합 |
| reference model | `tests/model/ref-model.ts` | 엔진과 **코드를 공유하지 않는** 단순한 메모리 해석기와 결과 비교. 엔진 알고리즘의 의미 오류 | 모델과 엔진이 같이 틀린 부분(모델도 사람이 만듦) |
| randomized / model-based | T-MODEL-001~005, `test:random` | 무작위 문장 수천 개 × seed. 사람이 쓰지 않을 조합(롤백 + DDL + 재오픈 + 인덱스) | **생성기가 만들지 않는 입력**(아래 사건 1) |
| differential | T-DIFF-001 | 인덱스 플랜과 SeqScan 결과 비교 | 둘 다 같은 오류 |
| crash fault injection | T-CRASH-P01~P03, 001~006, `test:crash` | 모든 write/fsync/truncate 지점 × 장애 정책(P-DURABLE, P-ALL, P-TORN, P-RANDOM)에서 crash → 재오픈 → (acked ⊆ 결과 ⊆ acked + in-flight) ∧ integrity | 모델 밖 장애(실제 전원, 섹터 순서) |
| corruption | T-CORR-001~004 | 모든 페이지 타입·WAL의 비트 플립이 **조용한 오답 없이** 오류로 감지되는가 | 감지 범위 밖의 손상(WAL 중간) |
| integrity check | I1~I12 (`integrity.ts:39`), 모든 통합 테스트 종료 시 실행(T-INTEG-001) | 다른 테스트가 끝난 뒤 남은 구조적 손상 | 검사기 자체의 약점(사건 2) |
| mutation | 일부러 버그를 넣고 테스트가 실패하는지 확인 | **테스트의 힘**. 테스트가 정말 그 성질을 검사하는지 | — |
| independent review | `CLAUDE_INDEPENDENT_REVIEW.md` | 구현자의 가정을 믿지 않고 다시 추적. 새 테스트·새 변이 | 같은 에이전트가 수행했으므로 사람의 독립 리뷰만큼 독립적이지는 않다 |

**오라클 독립성**: 크래시 테스트의 기대 상태는 **참조 모델에서** 계산하고, 장애 없는 엔진 실행에서 가져오지 않는다
(`tests/support/sql-crash.ts`). 엔진 결과를 정답으로 쓰면 엔진 버그가 정답이 되기 때문이다.

### H.2 실제 사건 1 — row move 변이를 무작위 테스트가 놓쳤다

- P13에서 "행 이동 시 인덱스 갱신 생략" 변이를 넣었는데 무작위 모델 테스트가 통과했다.
- 원인: 생성기의 TEXT가 짧아서 UPDATE로 행이 커져도 같은 페이지에 들어갔다. **행 이동 경로가 실행되지 않았다**.
- 해결: 생성기에 6% 확률로 300~650바이트 TEXT를 추가(`tests/model/generator.ts`). 512바이트를 넘으면 인덱스
  키 한도도 넘으므로 모델에 `KEY_TOO_LARGE` 예측도 추가했다. 이후 변이가 검출됐다.
- 리뷰에서 재확인(변이 M8): 지금은 짧은 모델 테스트(T-MODEL-002/003), T-IDX-002, T-EXEC-004, 리뷰 REVIEW-RM-001이
  모두 이 변이를 잡는다.
- 교훈: **무작위 테스트는 생성기가 만드는 입력 분포만큼만 강하다.** "통과했다"는 "그 경로를 실행했다"가 아니다.

### H.3 실제 사건 2 — I11 count-only 변이가 기존 suite를 통과했다

- 독립 리뷰의 변이 M11: integrityCheck의 I11(인덱스 ↔ 힙)을 "항목 **개수**만 비교"로 약화했는데
  `npm run check` 전체가 통과했다.
- 원인: 기존 테스트(T-INTEG-002)는 인덱스 항목을 **삭제**해서 손상을 만들었다. 삭제는 개수도 바꾸므로 약한 검사도 잡았다.
- 해결: 항목 수는 그대로 두고 내용만 틀리게 만드는 테스트 T-INTEG-004를 main suite에 추가했다(dangling RID,
  다른 살아있는 행의 RID, 틀린 PK 키). M11을 다시 넣자 `npm run check`가 T-INTEG-004에서 실패했다(커밋 `1980a97`).
- 교훈: **검사기 자체도 검증 대상이다.** "손상을 하나 감지한다"와 "그 성질 전체를 검사한다"는 다르다.

### H.4 실제 사건 3 — F2 제거가 DB를 열 수 없게 만들었다

- 리뷰 변이 M3(WAL reset에서 F2 제거) → T-CRASH-P03이 `WAL_HEADER_INVALID`로 실패(B.5).
- 교훈: 군더더기처럼 보이는 fsync도 **특정 crash 지점 × 특정 장애 정책**에서만 드러나는 역할이 있다. 모든 지점을
  전수로 crash시키는 matrix가 그래서 필요하다. 또 같은 변이로 실패한 WAL 단위 테스트는 op 번호 하드코딩 때문에
  실패한 것이라, 변이 결과는 "어떤 테스트가 왜" 실패했는지까지 읽어야 한다.

### H.5 실제 사건 4 — 복구 재크래시는 쉬운 정책에서만 검증되고 있었다

- 기존 T-CRASH-P02/002는 복구 도중 crash를 P-DURABLE/P-ALL로만 만들었다. 찢긴 쓰기, 무작위 부분 반영,
  "복구의 복구도 crash"는 없었다.
- 리뷰 REVIEW-CR-001이 5,068건 + 이중 crash 714건을 돌렸다. 결함은 없었다. 그 부분집합을 T-CRASH-006으로
  `test:crash`에 편입했다(약 1,180건 + 160건, 약 6초). T-CRASH-006 단독으로 "복구 시 F5 제거" 변이(M2)를 잡는다.

### H.6 변이 테스트 결과 요약

- 구현 단계: Page 0 복원 제거, NULL 정렬, UPDATE 유일성, 분할 시 리프 연결, 행 이동 인덱스 갱신, 커밋 fsync 제거,
  checkpoint 순서 역전 → 전부 검출(사건 1은 생성기 보강 후).
- 리뷰 단계: 새 변이 11개 중 10개를 `npm run check`가 검출. 생존 1개(M11) → T-INTEG-004로 해결.
- 변이 테스트는 "코드가 맞다"를 증명하지 않는다. "**이런 종류의 실수를 하면 테스트가 알려 준다**"를 증명한다.

---

## I. 실제로 발견한 버그·설계 수정

### I.1 Page 0 rollback 모호성 (rev1)

- **문제**: "Page 0 항상 상주"(G.1)와 "롤백 = dirty 프레임 제거"(G.5)가 Page 0에서 충돌했다.
- **왜 위험했나**: 구현자가 둘 중 하나를 임의로 택하면, 상주가 깨져 `pageCount` 읽기가 실패하거나, 롤백 후에도
  헤더가 미커밋 값(늘어난 `pageCount`, 바뀐 freelist)을 유지한다. 후자는 페이지 누수나 freelist 손상으로 이어진다.
- **발견**: 구현 전 설계 정합성 점검.
- **수정**: `headerBefore`로 제자리 복원(rev1, DC-23/24). T-PGR-007/008, 리뷰 REVIEW-P0-001.
- **배운 것**: 예외적인 페이지 하나가 일반 규칙과 충돌하는 지점은 **구현 전에** 하나로 정해야 한다.

### I.2 API 인수 오용 → FAILED (리뷰 L-1)

- **문제**: `db.execute(undefined)`, `execute(sql, null)`, `executeScript(null)` 같은 호출이 내부 TypeError →
  `InternalError INVARIANT_VIOLATION` → 핸들 **FAILED**가 됐다.
- **왜 위험했나**: 데이터 손상은 없지만, JS 호출자의 단순 실수로 열린 트랜잭션이 사라지고 핸들을 다시 열어야 했다.
  SPEC H.5는 "UsageError = 상태 변경 없음"을 약속하고 있었다.
- **발견**: 독립 리뷰에서 다른 테스트를 쓰다가 실수로 `execute()`를 인수 없이 호출해 TypeError를 본 것이 계기다.
  fail-first 테스트 REVIEW-API-001(4건 실패)로 재현했다.
- **수정**: 공개 경계에서 인수 검사 → `UsageError INVALID_OPTION`(`checkSql`, `checkExecuteOptions`, 커밋 `7f5396d`).
  T-ERR-004. 엔진 내부 오류의 FAILED 동작은 그대로다(T-ERR-003).
- **배운 것**: TypeScript 타입은 JS 호출자를 보호하지 않는다. "오류를 FAILED로 감싸는 안전장치"가 너무 넓으면
  사용자 실수까지 치명적 오류로 바꾼다.

### I.3 `onResult` callback 예외 → FAILED (DEC-008)

- **문제**: `executeScript(sql, onResult)`에서 사용자 callback이 던진 예외가 `wrap()`에 도달해 `InternalError`로
  바뀌고 핸들이 FAILED가 됐다.
- **왜 위험했나**: 사용자 코드의 오류를 엔진 버그로 오인한다. 원래 예외 타입·정보를 잃는다.
- **발견**: L-1 수정 후 남은 같은 계열의 경로로 확인했다.
- **수정**: callback 호출을 별도 경계로 분리해 원래 예외를 그대로 전파한다. statementIndex를 붙이지 않고,
  FAILED로 만들지 않으며, 스크립트는 중단한다. callback은 문장 완료 **후**에 호출되므로 이미 완료된 문장은
  롤백하지 않는다. 명시적 트랜잭션은 열린 채 남는다(커밋 `746d5ba`, T-ERR-005).
  UsageError로 감싸는 대안은 인수 오용이 아니고 원래 정보를 잃으므로 택하지 않았다.
- **배운 것**: 오류 분류 경계는 "누구의 코드에서 났는가"로 그어야 한다.

### I.4 I11 test gap (리뷰 TG-1)

H.3 참고. 문제(검사기 약화가 감지되지 않음) → 위험(인덱스 ↔ 힙 불일치를 integrityCheck가 놓쳐도 아무도 모름) →
발견(변이 M11) → 수정(T-INTEG-004 main suite 편입) → 배움(검사기 자체를 변이로 시험).

### I.5 recovery re-crash test gap (리뷰 TG-2)

H.5 참고. 문제(재크래시 검증이 쉬운 정책에만) → 위험(찢긴 쓰기 중 복구 버그가 숨을 수 있음) → 발견(리뷰에서
테스트 정책 목록 확인) → 수정(T-CRASH-006) → 배움(결함 0건도 결과다. 검증 범위를 넓혀 확인한 뒤 회귀 방지용
부분집합만 정규 스위트에 남김).

### I.6 stale-lock race (리뷰 L-2) — 수정하지 않고 문서화

- **문제**: 락 파일의 PID가 죽은 프로세스면 "읽기 → 삭제 → 재생성"으로 인수한다(`acquireLock`,
  `src/storage/node-vfs.ts:139`). 원자적이지 않아서, 두 프로세스가 동시에 같은 stale 락을 보면 A가 새로 만든 락을
  B가 stale로 알고 지우고, 둘 다 락을 얻을 수 있다.
- **왜 위험한가**: 두 writer가 같은 DB에 쓰면 손상된다. 단 crash로 stale 락이 남은 직후에 두 프로세스가 동시에
  열 때만 생긴다.
- **발견**: 리뷰 코드 읽기(재현하지 않음).
- **처리**: v1 범위는 단일 프로세스·협력적 락이다. 락 코드는 바꾸지 않고 DC-52, G.15 6단계, LIMITATIONS,
  REVIEW_PACKET §8에 기록했다. 원자적 인수는 FUTURE다.
- **배운 것**: 모든 발견을 고칠 필요는 없다. 범위 밖이면 **정확히 기록하는 것**이 올바른 처리다.

---

## J. Limitations — 숨기지 않는 것이 설명의 일부다

| 한계 | 구체적으로 | 왜 받아들였나 / 어떻게 다룰 수 있나 |
|---|---|---|
| 실제 전원 차단 미검증 | 모든 crash 검증은 `MemoryVfs`/`FaultVfs` 시뮬레이션 | 실험 장비 비용 대비 학습 가치가 낮다. 주장은 "검증된 장애 모델 안에서"로 한정 |
| FaultVfs ≠ 실제 OS/디스크 | 찢김은 **접두사**로만 모델링. 한 쓰기 안의 섹터 순서 뒤바뀜, 잘못된 위치 쓰기(misdirected), 팬텀 쓰기는 모델에 없음. 장애 모델과 엔진을 같은 작성자가 만들어 맹점을 공유할 수 있음 | 설계상 WAL 프레임 체크섬과 F5 전 재기록으로 견딜 것으로 추론하지만 **증명하지 않았다**(TG-3) |
| 플랫폼 | Windows 11에서만 실행(Node 24.16.0, 20.20.2). Linux/macOS 미실행 → 실제 디렉터리 fsync(F1)와 POSIX NodeVfs 경로 미검증. Windows는 디렉터리 fsync 불가(NTFS에 의존) | WSL/Linux가 없는 환경이었다. 첫 번째로 해 볼 만한 추가 검증 |
| single-process | 동시성 제어·MVCC 없음. 같은 프로세스 이중 오픈은 막지만 다중 프로세스는 협력적 락 + stale 인수 경쟁(I.6) | 설계 범위(LIMITATIONS) |
| WAL mid-log corruption | WAL 중간 비트 플립 = 찢긴 꼬리와 구분 불가 → 이후 커밋이 조용히 폐기(일관되지만 손실). 더 새 WAL 이미지가 있는 데이터 페이지 손상은 보고 없이 덮어써짐 | 형식 v2(프레임별 트랜잭션 표식)가 필요(FUTURE) |
| tail-only heap insertion | 삽입은 꼬리 페이지에만. 앞쪽 빈 공간은 같은 페이지 UPDATE로만 재사용 → 삭제 위주 워크로드에서 파일 증가(B10: +31% 후 평형) | free-space map이 없는 단순화(DC-61) |
| lazy B+tree deletion | 빈 리프·separator 유지, 트리가 줄지 않음 | 병합 구현량·버그 표면 대비 이득 작음(C.1.4) |
| no-steal 한도 | 트랜잭션당 dirty 페이지 ≤ `cachePages − 32` | undo 로그를 없앤 대가 |
| 기능 범위 | JOIN, 집계, GROUP BY, 서브쿼리, ALTER, REAL, 복합 인덱스, ORDER BY 인덱스 사용, top-N 없음. 정수는 ±(2^53−1) | 학습 목표(저장·트랜잭션·인덱스·검증)에 집중 |
| 행·키 크기 | 행 ≤ 4060바이트(오버플로 페이지 없음), 인덱스 키 ≤ 512바이트 | 형식 단순화 |
| FAILED 후 복구 수단 | salvage/읽기 전용 모드 없음. 테이블 루트 페이지 하나가 손상되면 open 자체가 실패 | 안전한 방향(손상 위에 쓰지 않음)을 택함 |

---

## Self Check

답은 이 문서와 저장소(코드·테스트·DURABILITY·DECISIONS)에서 직접 찾아 자기 말로 설명해 본다.

1. no-steal이면 왜 undo 로그 없이도 원자성이 유지되는가? no-steal의 대가는 무엇이고, 어떤 오류 코드로 드러나는가?
2. redo-only WAL에 "페이지 전체 이미지"를 기록하는 것이 복구의 멱등성과 어떻게 연결되는가? delta 로그였다면 무엇이 문제였을까?
3. 커밋 경로에서 F4 **전에** crash하면 재오픈 후 가능한 상태는 무엇무엇이고, 왜 둘 다 허용되는가?
4. F4 성공 **후** API 반환 전에 crash하면? 호출자는 성공 응답을 받지 못했는데 데이터가 보이는 것은 올바른가?
5. F5 전에 WAL을 truncate하면 어떤 시나리오에서 acknowledged commit이 사라지는가?
6. F3가 곧 같은 파일을 fsync하는데도 F2가 필요한 이유를 crash 지점과 DC-22 규칙으로 설명하라.
7. F1은 무엇을 내구화하며, Windows에서는 왜 수행되지 않는가? 그 공백은 어디에 기록되어 있는가?
8. WAL read-through가 없다면 어떤 순서의 연산에서 커밋된 데이터 대신 옛 데이터를 읽게 되는가?
9. `scanWal`이 프레임을 `pending`에 쌓다가 COMMIT 플래그에서 `committed`로 옮기는 이유는? 체크섬 체인이 없다면 무엇이 깨지는가?
10. WAL 중간의 비트 플립은 왜 찢긴 꼬리와 구분할 수 없고, 그 결과 어떤 데이터 손실이 생기는가?
11. 복구 도중 다시 crash해도 결과가 같은 이유는? 이를 검증하는 테스트 ID 두 개 이상을 들어라.
12. 자동 checkpoint가 커밋 직후가 아니라 "다음 문장 시작 시"에 수행되는 이유는(DC-26)?
13. `commitTxn`에서 WAL 쓰기가 실패하면 왜 `IO_COMMIT_UNKNOWN`이고, 왜 재시도하지 않고 FAILED가 되는가?
14. Page 0만 롤백 방법이 다른 이유는? rev1 이전 문서의 어떤 두 규칙이 충돌했는가?
15. 명시적 트랜잭션에서 S1이 Page 0을 dirty로 만들고 S2가 Page 0을 다시 수정하다 실패하면, S2 롤백 후 Page 0의 바이트·dirty 여부·`headerBefore`는 각각 무엇인가?
16. `headerBefore` 캡처가 dirty 한도 검사 **뒤에** 오는 것이 왜 중요한가?
17. 롤백 후 카탈로그 캐시를 무효화하지 않으면 어떤 버그가 생기는가(DC-25)?
18. slotted page에서 compaction 후에도 RID가 변하지 않는 이유는? 행이 다른 페이지로 이동하면 무엇을 반드시 해야 하는가?
19. 꼬리 페이지에 있던 행이 커져 이동할 때 같은 페이지로 되돌아올 수 없는 이유를 공간 계산으로 설명하라.
20. INTEGER 키 인코딩에서 부호 비트를 뒤집지 않으면 어떤 값들의 순서가 틀어지는가?
21. TEXT 비교에 JS의 `<`를 쓰면 왜 틀리는가? 어떤 문자 쌍에서 드러나는가?
22. non-unique 인덱스에서 키만 비교하면 왜 안 되는가? 삭제와 범위 탐색 두 측면에서 설명하라.
23. 인덱스 루트 페이지 ID를 고정한 이유를 카탈로그 행의 성질(삽입·삭제만)과 연결해 설명하라.
24. lazy deletion에서 빈 리프가 남아도 탐색이 틀리지 않는 이유는? 대가는 무엇이고 벤치마크는 무엇을 보여 줬나?
25. UPDATE를 스트리밍으로(스캔하며 바로 갱신) 처리하면 어떤 문제가 생기는가? 인덱스 스캔과 행 이동 각각의 예를 들어라.
26. `UPDATE t SET id = id + 1`이 성공해야 하는 이유와, 행 단위 유일성 검사였다면 왜 실패하는지 설명하라.
27. UPDATE의 인덱스 적용에서 "옛 항목 전부 삭제 → 새 항목 전부 삽입" 순서가 필요한 이유는?
28. 인덱스로 후보를 줄인 뒤에도 WHERE 전체를 Filter로 남기는 이유는? 이 설계 때문에 SQL 결과로는 드러나지 않는 버그의 예는?
29. DEC-006(512바이트 초과 리터럴)과 DC-43(플랜 의존 런타임 오류)은 무엇이 다른가? `WHERE x * 2 > 0 AND id = 1` 예로 설명하라.
30. 크래시 테스트의 기대 상태를 엔진의 무장애 실행이 아니라 참조 모델에서 계산하는 이유는?
31. model-based testing과 mutation testing은 각각 무엇을 증명하고 무엇을 증명하지 못하는가?
32. 행 이동 변이를 무작위 테스트가 처음에 놓친 이유와, 그 사건이 무작위 테스트 일반에 대해 알려 주는 것은?
33. I11 count-only 변이가 기존 suite를 통과한 이유는? 새 테스트는 어떻게 손상을 만들었는가?
34. API 인수 오용과 `onResult` callback 예외를 각각 어떤 오류로 처리하기로 했고, 왜 두 처리 방식이 다른가?
35. 이 프로젝트의 내구성 주장을 한 문장으로 말하라. 어떤 조건을 반드시 붙여야 하고, 어떤 표현은 쓰면 안 되는가?
