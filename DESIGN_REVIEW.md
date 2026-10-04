# Mini DB — DESIGN_REVIEW.md (확정 설계)

- 문서 성격: 구현 전 설계 검토 결과이자 **구현 세션의 확정 설계**. 구현 세션은 이 문서를 재해석하지 않고 따른다.
- 변경 규칙: 이 문서를 바꿀 필요가 생기면 구현 세션은 먼저 `DECISIONS.md`에 `DEC-NNN`(변경 내용·사유·영향 문서/테스트)을 기록하고, 관련 문서·테스트를 함께 고친다. 이 문서의 결정 ID(`DC-xx`), 불변식 ID(`I*`, `D*`), fsync 지점 ID(`F*`), 위험 ID(`R*`), 테스트 ID(`T-*`)는 안정 식별자이며 재사용·재번호하지 않는다.
- 근거 표기: 특정 DB 제품 이야기는 "일반적으로 알려진 설계"로만 표기하며, 이 문서의 결정은 그 제품의 세부 구현에 의존하지 않는다.
- 개정 이력: **rev1 (2026-10-04, 구현 전 정합성 점검)** — (1) Page 0 롤백 동작 확정: 프레임을 제거하지 않고 `txn.headerBefore`로 제자리 복원(DC-23, DC-24, C.1.2, G.1, G.3, G.4, G.5, I14, T-PGR-007/008). 결과 의미(롤백 = 마지막 커밋 상태)는 그대로이고 G.1 "항상 상주"와 G.5의 모순만 해소. (2) M의 P6 선행 조건을 M.1과 같은 P5로 통일. 구현 전 개정이므로 P0의 `DEC-000`(이 문서 채택)에 "rev1 기준 채택"으로 기록한다.
- 작성 기준일: 2026-10-03. 검토 환경: Windows 11, Node v24.16.0 (요구 하한은 Node 20).

---

## A. Executive Review

### A.1 초기 설계안 평가

| # | 항목 | 판정 | 요지 |
|---|---|---|---|
| 1 | 기술 스택 (TS/Node/Vitest, 의존성 0) | **유지 + 수정** | TypeScript 유지. 단 파일 I/O는 Promise 기반 `FileHandle`이 아니라 **동기 fd API**(`openSync/readSync/writeSync/fsyncSync/ftruncateSync`)를 `Vfs`/`StorageFile` 뒤에 둔다. `db.execute()`가 동기 API이고 Volcano iterator가 동기이므로 async 전파는 복잡도만 늘린다(DC-03). |
| 2 | 저장 구조 (4096B 페이지, LE, Page 0 헤더, 페이지 타입, CRC) | **유지 + 수정** | 모든 페이지(Page 0 포함)가 **동일한 16바이트 공통 헤더**를 갖도록 통일하고 magic은 Page 0의 오프셋 16에 둔다. 헤더에 `dbId`(8바이트 난수)를 추가해 WAL과 짝을 검증한다. 힙 체인의 head 페이지가 `tailPage`를 보유한다. 락 파일 이름은 `<db>-lock`. |
| 3 | 데이터 모델 | **수정** | 카탈로그를 "테이블 행 + 컬럼 행 + 인덱스 행"으로 이루어진 시스템 힙(page 1)으로 확정. INTEGER는 안전 정수(±(2^53−1)) number, 디스크는 int64. 인덱스에 NULL은 저장하지 않는다. |
| 4 | Query language 범위 | **유지 + 축소** | SELECT 목록은 `*` 또는 **컬럼 이름 목록만**(표현식·별칭 없음). ORDER BY는 컬럼 이름만. `OFFSET`은 `LIMIT` 뒤에만. `IF [NOT] EXISTS`, 따옴표 식별자 없음. |
| 5 | Parser/Executor 구조 | **유지 + 수정** | 파이프라인 유지. UPDATE/DELETE는 대상 행을 **먼저 전부 수집(materialize)한 뒤 적용**(Halloween 문제 방지). 플래너는 인덱스를 범위 축소에만 쓰고 WHERE 전체를 Filter로 남긴다. |
| 6 | Persistence (Pager, StorageFile 3종) | **수정** | 커밋된 페이지는 데이터 파일이 아니라 WAL에 있으므로, Pager 읽기 경로를 **cache → WAL index → data file**로 확정(WAL read-through). 오픈 시 복구는 항상 checkpoint까지 수행해 WAL을 비운다. |
| 7 | Index 범위 | **수정** | 비유일 인덱스의 "키+RID 이어붙이기"는 가변 길이 TEXT에서 **순서가 깨진다**(`'a'‖RID` vs `'ab'‖RID`). 대신 (key, rid) **튜플 비교기 하나**를 쓴다. B+tree 루트 페이지 ID는 인덱스 수명 동안 **고정**(루트 분할 시 내용을 두 자식으로 내림)하여 카탈로그 갱신을 없앤다. |
| 8 | Transaction 범위 | **유지 + 보강** | no-steal + redo-only 페이지 이미지 WAL 유지. 문장 단위 원자성은 **페이지 before-image savepoint**로 구현. checkpoint는 트랜잭션 밖에서만. 실패 상태(FAILED) 정책 확정. |
| 9 | Error handling | **수정** | JS 내장 `SyntaxError`와의 충돌을 피하려고 `SqlSyntaxError`로 개명. API 오용용 `UsageError` 추가. 비-MiniDb 예외는 `InternalError`로 감싸고 FAILED. |
| 10 | 테스트 전략 | **유지 + 보강** | 장애 주입 정책(P-DURABLE/P-ALL/P-TORN/P-RANDOM), 참조 모델의 "오류 여부 + 허용 코드 집합" 판정, 테스트 ID 추적 스크립트를 추가. |
| 11 | Benchmark 전략 | **유지** | 데이터 크기를 Windows fsync 비용에 맞게 축소. 합격 기준이 아닌 건전성 확인 항목만. |
| 12 | 문서화 전략 | **유지 + 보강** | 문서-코드 정합성을 스크립트(`check:docs`)로 검사: 오류 코드 목록, fsync 지점 태그, 테스트 ID. |
| 13 | 단계별 구현 순서 | **수정** | 제안 순서는 P6(실행기)에서 "오류 후 일관성"을 요구하지만 트랜잭션은 P9에 있어 **선행 조건이 깨진다.** WAL·Pager 트랜잭션을 레코드 계층보다 **먼저** 만든다(P3~P5). 큰 단계를 쪼개 P0~P17의 18단계로 재편. |
| 14 | Git/commit 전략 | **유지** | 태그 `phase-NN-done`(두 자리). P0 문서 커밋만 `npm run check` 예외. |
| 15 | PROGRESS.md 규칙 | **유지** | 템플릿과 재개 절차를 N에 확정. |

### A.2 가장 큰 위험 10개

| 순위 | 위험 | 왜 큰가 | Risk ID |
|---|---|---|---|
| 1 | 쓰기 순서/fsync 누락 (커밋·checkpoint·WAL 리셋) | 테스트가 통과해도 실제 크래시에서만 드러남. 장애 주입이 유일한 증명 수단 | R01, R02, R08 |
| 2 | WAL 꼬리 처리 오류 (부분 트랜잭션 적용) | 미sync 쓰기의 임의 부분집합이 살아남는 경우를 놓치기 쉬움 | R04, R06 |
| 3 | 롤백 후 메모리 상태 불일치 (카탈로그 캐시, 힙 tail, 통계) | 페이지는 복원되지만 파생 캐시가 남으면 조용한 손상 | R23, R24 |
| 4 | B+tree 분할 버그 (고정 루트 분할, separator, 리프 연결) | 드물게 발생하고 증상이 늦게 나타남 | R11, R12, R13 |
| 5 | RID 이동·Halloween으로 인한 인덱스-힙 불일치 | UPDATE 경로가 가장 복잡 | R14, R15, R38 |
| 6 | slotted page 공간 계산/compaction | off-by-one이 다른 레코드를 덮어씀 | R17, R18 |
| 7 | pin 누락으로 인한 "축출된 프레임 수정" (변경 유실) | JS에서는 참조가 살아 있어 오류 없이 유실됨 | R25 |
| 8 | 오라클이 구현과 같은 버그 공유 / 비결정성 | 테스트가 거짓 안심을 줌 | R28, R29 |
| 9 | 장애 주입 하네스 자체의 버그 | 하네스가 틀리면 모든 크래시 테스트가 무의미 | R30 |
| 10 | 범위 확장·세션 중단으로 인한 상태 손실 | 18단계 장기 작업 | R32 |

### A.3 난이도·분량 평가

- 예상 코드량: `src/` 약 8,000~9,500줄, `tests/` 약 8,000~10,000줄(테스트 지원 코드·참조 모델 포함).
- 가장 어려운 부분(순서대로): Pager 트랜잭션/WAL/복구(P4~P5), B+tree(P12), 인덱스 통합의 UPDATE 경로(P13), SQL 수준 crash matrix(P14).
- 예상 작업 세션 수: **18~26 세션**(1 세션 = 사용량 한도 1회분 작업 가정). 단계별 추정은 M 참조. P4, P10, P12, P13은 각각 1.5~2 세션이 들 수 있다.

### A.4 범위를 줄인 곳 (이 문서에서 확정)

1. SELECT 목록 표현식·별칭 없음, ORDER BY 표현식/위치 번호 없음.
2. `IF [NOT] EXISTS`, 따옴표 식별자, `BEGIN TRANSACTION` 같은 동의어 없음.
3. 힙 free-space map 없음: 삽입은 항상 테이블의 tail 페이지 또는 새 페이지(DC-61).
4. 파일 축소(VACUUM)·페이지 반환 없음. 해제 페이지는 freelist로만 재사용.
5. 인덱스는 필터링에만 사용. ORDER BY를 위한 인덱스 순서 스캔 없음.
6. `CHECKPOINT` SQL 문 없음: `db.checkpoint()` API와 CLI `.checkpoint`만.
7. 잠금은 협력적 락 파일만(OS 수준 바이트 락 없음).
8. 손상 DB "구조(salvage) 모드" 없음: 손상 감지 시 FAILED.
9. 실제 전원 차단 테스트 없음: 크래시 의미론은 `FaultVfs` 모델로만 검증(LIMITATIONS에 명시).

### A.5 작성 전 자체 점검 결과

| 점검 | 결과 |
|---|---|
| 모든 쓰기 경로에서 "이 시점 크래시 시 보이는 것"을 설명할 수 있는가 | G.9의 크래시 관찰표에 커밋·checkpoint·WAL 리셋·생성·복구의 모든 단계를 기재 |
| 모든 R에 실행 가능한 테스트가 있는가 | I의 각 R에 J에서 정의된 T-ID를 연결. `check:docs --final`이 존재를 검사 |
| 단계가 stub 없이 완료·커밋 가능한가 | WAL을 Pager보다 먼저, Pager 트랜잭션을 레코드보다 먼저 두어 각 단계가 하위 단계의 실제 구현만 사용 |
| 단계가 한 세션 크기인가 | 초안의 큰 단계(초안 P9 트랜잭션, 초안 P6 실행기)를 분할. 1.5~2 세션 단계는 내부 커밋 지점을 명시 |
| 문서·포맷·알고리즘 간 모순 | 상수(4096, 32, 4060, 512, 48, 24, 4120, 2048, 1000)를 C·D·G에서 동일 값으로 대조 완료 |
| 범위가 Core를 넘지 않는가 | 추가한 것은 `UsageError`, `executeScript`, `forceSeqScan` 테스트 옵션뿐(모두 Core 기능의 필수 보조) |

---

## B. Requirements Gaps & Ambiguities

| ID | 유형 | 내용 | 해소 |
|---|---|---|---|
| B-01 | 상충 | "FileHandle(read/write/sync)"(Promise)와 "동기적 사용 / `db.execute()`가 결과 반환"이 충돌 | 동기 fd API 사용 (DC-03) |
| B-02 | 누락 | 커밋된 페이지 이미지는 WAL에만 있는데, 캐시에서 축출되면 어디서 다시 읽는지 정의 없음 | WAL index read-through (DC-18, G.2) |
| B-03 | 누락 | 문장 단위 원자성의 구현 방법(명시적 트랜잭션 안에서) | 페이지 before-image savepoint (DC-23) |
| B-04 | 결함 | 비유일 인덱스의 "키+RID 이어붙이기"는 TEXT에서 memcmp 순서를 깨뜨림 | (key, rid) 튜플 비교기 (DC-28) |
| B-05 | 누락 | 인덱스에서 NULL 처리, UNIQUE에서 다중 NULL 허용 여부 | NULL 미색인, 다중 NULL 허용 (DC-28, DC-33) |
| B-06 | 누락 | 루트 분할 시 루트 페이지 ID가 바뀌면 카탈로그 갱신이 필요 | 루트 ID 고정 (DC-29) |
| B-07 | 누락 | UPDATE에서 행 단위 즉시 유일성 검사는 처리 순서에 따라 결과가 달라짐(`SET id = id + 1`) → 참조 모델이 예측 불가 | UPDATE는 문장 수준 유일성 검사 (DC-31) |
| B-08 | 누락 | UPDATE/DELETE 중 행 이동으로 같은 행을 두 번 보는 Halloween 문제 | 대상 materialize (DC-62) |
| B-09 | 누락 | 힙 삽입 위치(free space 관리) 정책 | tail 페이지 정책 (DC-61) |
| B-10 | 모호 | 락 파일 "최소 구현"의 stale 처리 | PID 생존 확인 (DC-52) |
| B-11 | 상충 | 오류 클래스명 `SyntaxError`가 JS 전역과 충돌 | `SqlSyntaxError` (DC-54) |
| B-12 | 누락 | `MAX_ROW_BYTES` 등 수치 | DC-10~DC-13 |
| B-13 | 모호 | WHERE의 런타임 오류(오버플로)가 플랜(SeqScan/IndexScan)에 따라 달라질 수 있음 | "평가된 행에 대해서만 오류" 명시, 무작위 생성기는 WHERE에 오버플로 가능 식을 넣지 않음 (DC-43, J.4) |
| B-14 | 모호 | ORDER BY 동률 + LIMIT의 결과 비결정성 | 명세상 비결정. 생성기는 LIMIT 사용 시 PK로 끝나는 전순서 ORDER BY만 생성 (DC-42, J.4) |
| B-15 | 누락 | no-steal에서 캐시 용량의 의미(커밋됐지만 checkpoint 전인 페이지 포함 여부) | 커밋된 페이지는 clean으로 취급(WAL에 있음). 한도는 트랜잭션 dirty 페이지 수만 (DC-16) |
| B-16 | 누락 | 트랜잭션 진행 중 checkpoint 허용 여부 | 트랜잭션 밖에서만 (DC-26) |
| B-17 | 누락 | 열린 트랜잭션이 있는 상태의 `close()` | 롤백 후 checkpoint (DC-60) |
| B-18 | 누락 | 트랜잭션 안 DDL 허용 여부, 롤백 시 카탈로그 캐시 | 허용, 롤백 시 캐시 무효화 (DC-25, DC-48) |
| B-19 | 누락 | WAL 헤더 손상과 "리셋 도중 크래시"의 구분 | truncate→fsync→header→fsync 순서 + 크기 규칙 (DC-22, G.6) |
| B-20 | 누락 | DB 파일 생성 도중 크래시 | 생성 자체를 bootstrap 트랜잭션으로 (DC-63) |
| B-21 | 누락 | 다른 DB의 WAL 파일이 옆에 있는 경우 | `dbId` 대조 (DC-64) |
| B-22 | 모호 | Page 0의 레이아웃과 공통 페이지 헤더의 관계 | 공통 헤더 통일, magic은 offset 16 (DC-06) |
| B-23 | 누락 | 한 번의 `execute()`에 여러 문장 | `execute`는 1문장, `executeScript`는 여러 문장 (DC-59) |
| B-24 | 누락 | 트랜잭션 중 `integrityCheck()`/`checkpoint()` | `TransactionError TXN_ACTIVE` (DC-58) |
| B-25 | 결함 | JS 문자열 비교(`<`)는 UTF-16 순서라 UTF-8 바이트 순서와 다름(보충 평면 문자) | 바이트 순서 비교 함수 강제 (DC-39) |
| B-26 | 누락 | lone surrogate가 든 문자열 리터럴은 UTF-8로 손실 변환됨 | 렉서에서 거부 (F.1) |
| B-27 | 누락 | 줄바꿈(CRLF) 처리와 위치 계산 | `\n`만 줄 구분, `\r`은 공백 (DC-55, DC-69) |
| B-28 | 상충 | 초안 단계 순서에서 P6가 트랜잭션(P9) 없이 문장 원자성을 요구 | 단계 재편 (DC-67, M) |
| B-29 | 누락 | `OFFSET` 단독, 음수 LIMIT | 문법상 금지 (DC-37) |
| B-30 | 누락 | 런타임 오류(제약 위반·오버플로)의 위치 정보 | 바운드 노드의 소스 위치 사용 (H.4) |
| B-31 | 누락 | `EXPLAIN`의 대상(SELECT만인지) | SELECT만 (F.2) |
| B-32 | 누락 | 같은 컬럼에 인덱스 2개 | 허용, 플래너는 이름순 결정 (F.8) |
| B-33 | 누락 | 예기치 않은 JS 예외(TypeError 등)의 처리 | `InternalError`로 감싸고 FAILED (DC-51) |
| B-34 | 누락 | 테스트에서 난수(dbId, salt)의 결정성 | `entropy` 주입 (DC-65) |
| B-35 | 모호 | "참조 모델"이 오류 코드를 어떻게 예측하는가 (여러 위반 동시 발생 시) | "실패 여부 + 허용 코드 집합" 판정 (J.4) |
| B-36 | 상충 | 2단계 프롬프트의 단계 번호(P0~P12)와 이 문서의 단계(P0~P17) | 2단계 프롬프트가 허용한 대로 이 문서를 따른다 (M) |

---

## C. Final Design Decisions

### C.1 대안 비교

#### C.1.1 내구성 방식

| 대안 | 장점 | 단점 |
|---|---|---|
| **WAL (redo-only, 페이지 이미지)** | 커밋당 fsync 1회. 데이터 파일은 checkpoint 때만 쓰므로 커밋 경로가 단순한 append. 복구 = 커밋된 이미지 재적용(멱등). checkpoint·복구 시간 같은 학습 주제를 그대로 드러냄 | 커밋됐지만 checkpoint 전인 페이지를 WAL에서 다시 읽어야 함(WAL index). WAL 크기 관리 필요 |
| rollback journal | 데이터 파일이 항상 최신이라 읽기 경로가 단순 | 커밋당 fsync 2~3회(저널, 데이터, 저널 무효화). 크래시 복구가 undo라 "원래 이미지 보존" 순서가 까다로움 |
| shadow paging (CoW) | 루트 포인터 원자 교체로 커밋. 복구 거의 불필요 | B+tree 경로 복사, 이전 버전 페이지 회수(GC), 헤더 이중화가 필요. 이번 범위에서 가장 큰 구현량 |

- **선택: WAL(redo-only, 페이지 이미지, 체크섬 체인, commit 표시).**
- 번복 조건: WAL index read-through로 인한 버그가 P5까지 2회 이상 같은 원인으로 재발하면, "커밋 직후 즉시 checkpoint"(force) 모드로 단순화하고 DECISIONS에 기록한다(포맷 변경 없음).

#### C.1.2 버퍼 정책

| 대안 | 장점 | 단점 |
|---|---|---|
| **no-steal** | 미커밋 데이터가 디스크에 절대 가지 않으므로 undo 로그 불필요. 롤백 = 캐시의 dirty 프레임 폐기(상주하는 Page 0만 이미지 복원) | 트랜잭션 크기가 캐시에 묶임(LimitError) |
| steal + undo | 큰 트랜잭션 가능 | undo 로그, 보상 로직, 복구 시 undo 단계. 범위 초과 |

- **선택: no-steal.** 한도 초과 시 `LimitError TXN_TOO_LARGE`.
- 번복 조건: 없음(v1). 큰 트랜잭션 요구는 FUTURE.

#### C.1.3 행 저장

| 대안 | 장점 | 단점 |
|---|---|---|
| **slotted page** | 가변 길이 TEXT, 페이지 내 compaction 후에도 RID 안정(slot 간접 참조) | 공간 계산·compaction 구현 필요 |
| 고정 길이 슬롯 | 단순 | TEXT를 최대 길이로 예약해야 해 공간 낭비 극심, 또는 별도 저장소 필요 |

- **선택: slotted page.** 번복 조건: 없음.

#### C.1.4 B+tree 삭제 정책

| 대안 | 장점 | 단점 |
|---|---|---|
| **lazy 삭제** (항목만 제거) | 구현 단순, 분할 경로만 검증하면 됨 | 빈 리프·낮은 채움률이 남음, 트리가 줄지 않음 |
| 병합·재분배 | 공간 효율, 높이 감소 | 구현량과 버그 표면이 분할의 2배 이상 |

- **선택: lazy 삭제.** 번복 조건: 벤치마크(B8 삭제 후 재삽입)에서 페이지 수가 살아있는 항목 대비 10배를 넘는 등 실사용 문제가 확인되면 Stretch로 승격.

#### C.1.5 INTEGER 표현

| 대안 | 장점 | 단점 |
|---|---|---|
| **안전 정수 number** (±(2^53−1)) | API 값이 평범한 number. 산술이 빠르고 단순 | int64 전 범위 불가 |
| bigint | int64 전 범위 | API·비교·혼합 연산에서 bigint/number 혼동, 성능 저하 |

- **선택: 안전 정수 number. 디스크는 int64**(향후 bigint 전환 시 포맷 불변). 번복 조건: int64 전 범위가 요구되면 메모리 표현만 bigint로 바꾸고 포맷은 유지.

#### C.1.6 파서

| 대안 | 판정 |
|---|---|
| **재귀 하강 + precedence climbing** | 선택. 오류 위치·메시지를 직접 제어 |
| 파서 생성기 | **금지 확인**(의존성 규칙과 학습 목표 위반) |

#### C.1.7 실행 모델

| 대안 | 장점 | 단점 |
|---|---|---|
| **iterator (Volcano)** | LIMIT가 상위에서 멈추면 하위 스캔도 멈춤. 연산자 단위 테스트 쉬움 | 상태 기계 구현 |
| 전체 materialize | 단순 | 메모리, LIMIT 최적화 불가, 학습 목표(Volcano) 미달 |

- **선택: iterator.** 단 Sort와 UPDATE/DELETE 대상 수집은 materialize 지점으로 명시. `execute()`는 최종 결과를 배열로 모아 반환.

#### C.1.8 구현 순서

| 대안 | 장점 | 단점 |
|---|---|---|
| 제안 순서 (힙→SQL→인덱스→WAL) | SQL 수직 슬라이스가 빨리 보임 | 실행기 단계에서 문장 원자성이 필요한데 트랜잭션이 없음 → 임시 커밋 경로(나중에 버릴 코드) 필요. 원자성·내구성이 가장 늦게 검증됨 |
| **WAL·Pager 트랜잭션을 먼저** | 가장 위험한 부분을 페이지 수준의 단순한 오라클로 일찍 검증. 이후 모든 계층이 최종 Pager API를 그대로 사용(stub 없음) | SQL이 늦게 보임 |
| 인덱스를 힙보다 먼저 | B+tree를 일찍 검증 | 카탈로그·SQL 없이 의미 있는 통합이 어려움, 이점 적음 |

- **선택: WAL·Pager 트랜잭션 먼저(P3~P5) → 레코드 → 카탈로그 → SQL → 실행기 → B+tree → 인덱스 통합 → SQL 수준 크래시.**
- 번복 조건: 없음. 단, P5 종료 시 누적 세션이 7을 넘으면 P11(모델 테스트·CLI) 중 CLI를 P17로 미룰 수 있다.

#### C.1.9 기술 스택 유지 여부

| 대안 | 평가 |
|---|---|
| **TypeScript/Node** | 바이트 처리(`Uint8Array`/`DataView`) 충분, Vitest 성숙, 설치 단순. 단점: GC·메모리 레이아웃 제어 불가, 64비트 정수 불편, 단일 스레드 |
| Rust | 메모리·I/O 제어 최상, 학습 곡선 가파름, 구현량 증가 |
| Go | 균형 좋음, 하지만 요구사항이 TS 학습 맥락 |
| Python | 느리고 바이트 처리 번거로움 |

- **선택: TypeScript 유지.** 성능 수치는 "엔진 설계의 상대 비교"용이며 절대 성능 목표가 아님을 BENCHMARKS에 명시.
- 번복 조건: 없음(v1).

### C.2 확정 결정표

> 표기: "예시·경계"는 구현·테스트가 바로 쓸 수 있는 값. "번복 조건"은 이 결정을 바꿔도 되는 유일한 조건이며, 바꿀 때는 DECISIONS에 기록한다.

#### 스택·런타임

| ID | 영역 | 확정 규칙 | 예시·경계 | 번복 조건 |
|---|---|---|---|---|
| DC-01 | 언어/런타임 | TypeScript, Node ≥ 20, ESM(`"type": "module"`), `module`/`moduleResolution` = `NodeNext`, `target` = `ES2022` | 시작 시 `node --version` < 20이면 중단 | 없음 |
| DC-02 | 의존성 | 런타임 의존성 0. devDependencies는 `typescript`, `vitest`, `@types/node`만. `package-lock.json` 커밋 | `scripts/*.mjs`는 Node 내장 모듈과 `typescript` API만 사용 | 없음 |
| DC-03 | 파일 I/O | `node:fs` 동기 fd API만 사용하며 `Vfs`/`StorageFile` 인터페이스 뒤에 숨긴다. `src/` 다른 곳에서 `node:fs` import 금지 | `readSync`/`writeSync`는 부분 읽기·쓰기를 루프로 완결 | 비동기 환경(브라우저 등) 지원 요구 |
| DC-04 | tsconfig | `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noImplicitReturns`, `forceConsistentCasingInFileNames`. `exactOptionalPropertyTypes`는 끔 | 모든 union `switch`는 `assertNever(x)`로 끝남 | 없음 |

#### 파일 형식

| ID | 영역 | 확정 규칙 | 예시·경계 | 번복 조건 |
|---|---|---|---|---|
| DC-05 | 페이지·엔디안 | 페이지 4096바이트 고정. 모든 다바이트 정수 필드는 **리틀 엔디안**. 예외: B+tree 키 바이트 안의 INTEGER 인코딩은 순서 보존용 **빅 엔디안** | `pageSize` 필드 ≠ 4096이면 `CorruptionError UNSUPPORTED_FORMAT_VERSION` | 없음 |
| DC-06 | magic·버전 | 모든 페이지 공통 헤더(16B) 뒤, Page 0 offset 16에 magic `4D 49 4E 49 44 42 00 00`("MINIDB\0\0"). `formatVersion` = 1(u16). WAL 버전 = 1 | magic 불일치 → `NOT_A_DATABASE`, 버전 ≠ 1 → `UNSUPPORTED_FORMAT_VERSION` | 없음 |
| DC-07 | 헤더 필드 | D.2 표가 전부(pageCount, freelistHead, freelistCount, catalogRoot, dbId) | catalogRoot는 항상 1 | 없음 |
| DC-08 | 페이지 체크섬 | CRC-32/IEEE(반사 다항식 0xEDB88320, init 0xFFFFFFFF, final xor 0xFFFFFFFF), 페이지 전체 4096바이트를 CRC 필드(offset 4..8)를 0으로 간주하고 계산. **모든 물리 읽기**(데이터 파일·WAL)에서 검증 | `crc32("123456789") = 0xCBF43926` | 없음 |
| DC-09 | 페이지 ID | u32. Page 0 = 파일 헤더. 포인터 값 0 = "없음"(Page 0은 어떤 구조의 자식도 아니므로 안전) | 최대 페이지 수 2^32−1 | 없음 |
| DC-64 | DB 식별자 | 생성 시 8바이트 `dbId`를 헤더와 WAL 헤더에 기록. 커밋 프레임이 있는 WAL의 dbId가 다르면 `CorruptionError WAL_MISMATCH` | 커밋 프레임이 없으면 WAL을 리셋하고 계속 | 없음 |
| DC-68 | 카탈로그 표현 | Page 1에서 시작하는 시스템 힙 `mdb_catalog`에 테이블 행·컬럼 행·인덱스 행을 공용 행 코덱으로 저장(D.7) | 사용자는 `mdb_catalog`를 질의할 수 없음 | 없음 |

#### 한도

| ID | 영역 | 확정 규칙 | 예시·경계 | 번복 조건 |
|---|---|---|---|---|
| DC-10 | MAX_ROW_BYTES | 인코딩된 행 ≤ **4060** 바이트(= 4096 − 힙 헤더 32 − slot 4). 초과 시 `LimitError ROW_TOO_LARGE` | 4060 성공, 4061 실패 | 없음 |
| DC-11 | MAX_KEY_BYTES | 인코딩된 인덱스 키(RID 제외) ≤ **512** 바이트. 초과 시 `LimitError KEY_TOO_LARGE`. 내부 노드 최소 팬아웃 7 보장 | TEXT 512바이트 키 성공, 513 실패 | 없음 |
| DC-12 | MAX_TEXT_BYTES | TEXT 값(리터럴 포함) ≤ **4000** UTF-8 바이트. 렉서에서 검사 → `LimitError TEXT_TOO_LARGE` | `'한'`은 3바이트. 1334자 `'한…'` = 4002바이트 → 실패 | 없음 |
| DC-13 | 컬럼·식별자 | 테이블당 컬럼 ≤ **64**(`TOO_MANY_COLUMNS`). 식별자 1~**64** 바이트, ASCII `[A-Za-z_][A-Za-z0-9_]*`(`IDENTIFIER_TOO_LONG`) | 64 성공, 65 실패 | 없음 |
| DC-14 | INTEGER 범위 | −9007199254740991 ~ 9007199254740991. 디스크는 int64 LE. 디스크 값이 범위 밖이면 `CorruptionError RECORD_MALFORMED` | 리터럴 9007199254740992 → `LimitError INTEGER_OUT_OF_RANGE` | C.1.5 |

#### 캐시·버퍼·트랜잭션

| ID | 영역 | 확정 규칙 | 예시·경계 | 번복 조건 |
|---|---|---|---|---|
| DC-15 | 캐시 | 옵션 `cachePages` 기본 **2048**(8 MiB), 허용 64~1,048,576(밖이면 `UsageError INVALID_OPTION`). 교체 정책: **LRU, clean이고 pin=0인 프레임만 축출** | 축출 시 쓰기 없음(커밋된 이미지는 WAL 또는 데이터 파일에 있음) | 없음 |
| DC-16 | no-steal 한도 | 트랜잭션 dirty 페이지 수가 `cachePages − 32`를 넘게 되는 `markDirty` → `LimitError TXN_TOO_LARGE`. 문장 롤백, 명시적 트랜잭션은 유지 | cachePages=64 → dirty 최대 32 | 없음 |
| DC-17 | pin | pin은 한 Pager 호출자 연산 내부에서만 유지(iterator `next()` 사이에 보유 금지). 문장 종료 시 pin 합계 0이 아니면 `InternalError`. 동시 pin ≤ 8 | B+tree 분할은 경로를 페이지 ID로 기록하고 다시 pin | 없음 |
| DC-23 | 문장 원자성 | 문장 시작 시 savepoint 맵을 비운다. 문장 안에서 어떤 페이지를 처음 `markDirty`할 때: 그 페이지가 이미 트랜잭션 dirty면 **현재 이미지 복사본**, 아니면 `null`을 기록. 문장 실패 시 복사본은 복원, `null`은 프레임 폐기(단 Page 0은 폐기하지 않고 트랜잭션 시작 시 이미지로 복원, G.5) | 자동 커밋 문장 실패 = 트랜잭션 롤백 | 없음 |
| DC-24 | 트랜잭션 롤백 | Page 0 외 dirty 프레임 전부 폐기(다음 읽기는 WAL index 또는 데이터 파일에서). Page 0은 항상 상주하므로 폐기하지 않고, 트랜잭션에서 처음 dirty될 때 저장한 이미지(`headerBefore`)로 제자리 복원 후 clean | 헤더 페이지도 페이지이므로 pageCount·freelist도 자동 복원 | 없음 |
| DC-25 | 파생 캐시 | 카탈로그 캐시 등 페이지에서 파생된 메모리 상태는 **모든 롤백(문장·트랜잭션) 후 무효화**하고 지연 재적재 | DDL 후 ROLLBACK → 테이블 사라짐 | 없음 |
| DC-26 | checkpoint 시점 | 트랜잭션이 없을 때만. 커밋 후 WAL 프레임 수 ≥ `walAutoCheckpointFrames`(기본 **1000**, 0이면 자동 끔)이면 `checkpointDue` 표시 → **다음 `execute()` 시작 시점(트랜잭션 밖)**, `close()`, `db.checkpoint()`에서 수행 | 자동 checkpoint 실패는 그 다음 문장의 오류로 보고(이미 성공한 커밋을 실패로 보고하지 않음) | 없음 |
| DC-48 | DDL과 트랜잭션 | DDL은 명시적 트랜잭션 안에서도 허용, 롤백 가능 | `BEGIN; CREATE TABLE t…; ROLLBACK;` → t 없음 | 없음 |
| DC-60 | close | 활성 명시적 트랜잭션은 롤백 → (FAILED가 아니면) checkpoint → 파일 닫기 → 락 해제. 두 번째 `close()`는 무시. 닫힌 핸들 사용 → `UsageError DB_CLOSED` | FAILED 상태 close는 쓰기 없이 닫고 락 해제 | 없음 |

#### WAL·복구

| ID | 영역 | 확정 규칙 | 예시·경계 | 번복 조건 |
|---|---|---|---|---|
| DC-18 | WAL 형식 | 헤더 48B + 프레임(헤더 24B + 페이지 4096B = 4120B). 프레임은 트랜잭션의 dirty 페이지를 pageId 오름차순으로, 마지막 프레임에 COMMIT 플래그. 체크섬 체인: `ck_k = CRC32(LE32(ck_{k−1}) ‖ frameHdr[0..16) ‖ page)`, `ck_{−1}` = 헤더 CRC. 프레임마다 헤더의 salt1/salt2 복사. **프레임 1개 = write 호출 1회** | 프레임 k 오프셋 = 48 + 4120·k | 없음 |
| DC-19 | 복구 중단 규칙 | 앞에서부터 스캔하며 다음 중 하나면 **중단**: 남은 바이트 < 4120, salt 불일치, 체크섬 불일치, 예약 필드/플래그 비정상. 마지막 COMMIT 프레임까지만 인정. 체인은 유효한데 페이지 CRC가 틀리면 `CorruptionError WAL_FRAME_INVALID` | 중간 비트 플립 = 그 지점 이후 폐기(크래시 꼬리와 구분 불가, LIMITATIONS) | 없음 |
| DC-20 | 읽기 경로 | dirty/clean 캐시 → WAL index(`pageId → 최신 커밋 프레임`) → 데이터 파일 | WAL에서 읽은 페이지도 CRC 검증 | C.1.1 번복 시 |
| DC-21 | checkpoint 순서 | WAL index의 각 페이지를 pageId 오름차순으로 데이터 파일에 쓰기 → **fsync(data) [F5]** → WAL truncate(0) → **fsync(wal) [F2]** → 새 헤더(seq+1, 새 salt) 쓰기 → **fsync(wal) [F3]** → WAL index 비움 | fsync 3회 | 없음 |
| DC-22 | WAL 파일 수명 | WAL 파일은 삭제하지 않는다. 리셋 = truncate + 헤더. 헤더 무효 ∧ 파일 크기 ≤ 48 → 빈 WAL. 헤더 무효 ∧ 크기 > 48 → `CorruptionError WAL_HEADER_INVALID` | 생성 직후 WAL 크기 = 48 | 없음 |
| DC-63 | 파일 생성 | 새 DB 생성은 bootstrap 트랜잭션: 파일 생성 → 디렉터리 fsync(F1) → WAL 리셋 → Page 0(헤더)·Page 1(카탈로그 head) 커밋(F4) → checkpoint. 데이터 파일 크기 0 ∧ 커밋 프레임 없음 = "새 DB" | 생성 중 어느 지점 크래시든 재오픈 성공 | 없음 |
| DC-65 | 난수 | dbId·salt는 옵션 `entropy: (n) => Uint8Array`(기본 `crypto.randomBytes`). 테스트는 seed PRNG 주입 | 같은 entropy·같은 연산 → 바이트 단위 동일 파일 | 없음 |

#### RID·인덱스

| ID | 영역 | 확정 규칙 | 예시·경계 | 번복 조건 |
|---|---|---|---|---|
| DC-27 | RID 안정성 | RID = (pageId u32, slotId u16). 같은 페이지 안 재배치·compaction은 RID 유지. 다른 페이지로 이동하면 새 RID이며 그 행의 **모든 인덱스 항목을 갱신**. 같은 RID면 값이 바뀐 컬럼의 인덱스만 갱신 | tombstone slot 재사용 가능(가장 낮은 번호) | 없음 |
| DC-28 | 인덱스 항목 | 항목 = (key 바이트, rid). 비교기 하나: `compareEntry(a,b) = compareBytes(a.key,b.key)`(사전식, 접두사가 작음) 후, **비유일 인덱스만** rid(pageId, slot) 비교. **NULL 값은 색인하지 않음** | 유일 인덱스는 같은 키 2개 불가 | 없음 |
| DC-29 | 루트 고정 | 인덱스 루트 페이지 ID는 생성부터 DROP까지 불변. 루트 분할 시 내용을 새 페이지 L, R로 옮기고 루트를 내부 노드로 재초기화 | 카탈로그는 DDL에서만 변경 | 없음 |
| DC-30 | 삭제 | lazy: 리프 항목만 제거, separator·빈 리프 유지 | C.1.4 | C.1.4 |
| DC-70 | 플래너 인덱스 사용 | 인덱스는 후보 행 축소에만 사용. **WHERE 전체를 Filter로 유지**(재검사). ORDER BY에 인덱스 순서 사용 안 함 | F.8 | 없음 |

#### 제약·의미론

| ID | 영역 | 확정 규칙 | 예시·경계 | 번복 조건 |
|---|---|---|---|---|
| DC-31 | 유일성 검사 시점 | INSERT: 행마다 힙 쓰기 **전에** 검사(앞서 같은 문장에서 넣은 행 포함). UPDATE: **문장 수준** — 모든 새 행을 계산한 뒤 (a) 새 값끼리 중복, (b) 새 값과 비대상 행의 값 중복을 검사하고, 통과해야 적용. 위반 시 문장 롤백 | `UPDATE t SET id = id + 1`(id 1,2,3) 성공 | 없음 |
| DC-32 | NOT NULL | 행을 쓰기 직전 검사. PRIMARY KEY 컬럼은 암묵적 NOT NULL | `INSERT INTO t(id) VALUES (NULL)` → `NOT_NULL_VIOLATION` | 없음 |
| DC-33 | UNIQUE와 NULL | NULL은 여러 개 허용(색인 안 함) | `CREATE UNIQUE INDEX` 후 NULL 2행 성공 | 없음 |
| DC-34 | NULL 정렬 | NULL은 가장 작은 값: ASC면 맨 앞, DESC면 맨 뒤 | `ORDER BY x DESC` → NULL 마지막 | 없음 |
| DC-35 | 정수 오버플로 | `+ − *` 및 단항 `−`의 **각 연산 결과**가 안전 범위 밖이면 `LimitError INTEGER_OVERFLOW`(그 연산 노드 위치) | `9007199254740991 + 1` → 오류 | 없음 |
| DC-36 | VALUES | `VALUES ()` → `SqlSyntaxError`. 행의 값 개수 ≠ 대상 컬럼 수 → `SemanticError COLUMN_COUNT_MISMATCH`. 컬럼 목록 생략 시 전체 컬럼 순서. 목록에 없는 컬럼은 NULL | VALUES 안 컬럼 참조 → `NOT_CONSTANT` | 없음 |
| DC-37 | LIMIT/OFFSET | 정수 리터럴만. `LIMIT 0` → 빈 결과(하위 연산자를 당기지 않음). 음수는 문법상 불가(`SqlSyntaxError`). `OFFSET`은 `LIMIT` 뒤에만. OFFSET ≥ 행 수 → 빈 결과 | `LIMIT 5 OFFSET 100` → 0행 | 없음 |
| DC-38 | 타입 검사 | 분석 단계에서 검사. 암묵 변환 없음. NULL 리터럴은 어느 타입과도 호환 | `WHERE id = '1'` → `TYPE_MISMATCH` | 없음 |
| DC-39 | 문자열 비교 | UTF-8 바이트 사전식(= 코드 포인트 순서). JS `<`, `localeCompare` 금지 | U+FF61 < U+1F600 | 없음 |
| DC-40 | 식별자 | 대소문자 무시, ASCII 소문자로 정규화. 키워드는 전부 예약어. 따옴표 식별자 없음 | `Users`와 `USERS`는 같은 테이블 | 없음 |
| DC-41 | SELECT 목록 | `*` 또는 컬럼 이름 목록(중복 허용). ORDER BY 항목은 테이블 컬럼 이름(목록에 없어도 됨) | `SELECT a, a FROM t` 허용 | 없음 |
| DC-42 | 결과 순서 | ORDER BY가 없으면 순서 미정. ORDER BY 동률 간 순서 미정 | 테스트는 다중집합 비교 | 없음 |
| DC-43 | 런타임 오류 범위 | 실제로 평가된 행·식에서만 오류. AND/OR 단락 평가(F.5). 어떤 행이 평가되는지는 플랜에 따라 다를 수 있음 | `WHERE a = 1 AND b * c > 0` | 없음 |
| DC-44 | 이름 공간 | 테이블과 인덱스는 하나의 이름 공간. 중복 → `SemanticError OBJECT_EXISTS` | `CREATE INDEX t ON …`(t가 테이블) → 오류 | 없음 |
| DC-45 | 예약 이름 | `mdb_`로 시작하는 이름은 사용자 생성 불가(`RESERVED_NAME`). PK 자동 인덱스 이름 = `mdb_pk_<table>`, `DROP INDEX` 불가(`CANNOT_DROP_PK_INDEX`) | | 없음 |
| DC-46 | DROP 페이지 회수 | DROP 문 안에서 즉시 freelist에 넣으며 같은 트랜잭션에서 바로 재사용 가능. 커밋 시 확정, 롤백 시 페이지 이미지 복원으로 원상태 | | 없음 |
| DC-47 | CREATE INDEX 실패 | 기존 행으로 구축 중 오류(유일성·키 크기·TXN_TOO_LARGE) → 문장 롤백: 카탈로그 행 없음, 할당 페이지 없음(누수 0) | | 없음 |
| DC-61 | 힙 삽입 위치 | head 페이지의 `tailPage`에 삽입 시도 → 공간 없으면 새 페이지 할당 후 체인 끝에 연결. 앞쪽 페이지의 빈 공간은 같은 페이지의 UPDATE·compaction으로만 재사용 | 삭제 위주 워크로드는 파일이 늘 수 있음(LIMITATIONS) | 벤치마크에서 심각한 팽창 확인 시 |
| DC-62 | UPDATE/DELETE 실행 | 대상 (rid, 기존 행) 목록을 먼저 전부 수집한 뒤 적용 | 행 이동이 있어도 각 행 정확히 1회 갱신 | 없음 |

#### 실패·잠금·플랫폼

| ID | 영역 | 확정 규칙 | 예시·경계 | 번복 조건 |
|---|---|---|---|---|
| DC-49 | FAILED 상태 | 진입 조건: (a) 커밋·checkpoint·복구·WAL 리셋 중 write/sync/truncate 오류, (b) `CorruptionError` 발생, (c) `InternalError` 발생. 이후 `close()`를 제외한 모든 호출 → `StorageError DB_FAILED`(원인을 `cause`로). 재시도 없음 | fsync 실패 후 재시도는 성공으로 보여도 신뢰할 수 없음(일반적으로 알려진 문제) | salvage 모드 요구 시 |
| DC-50 | 읽기 오류 | 데이터 파일/WAL **읽기** I/O 오류 → `StorageError IO_ERROR`, 문장 롤백, 핸들 사용 가능 | | 없음 |
| DC-51 | 예기치 않은 예외 | `Database` 공개 메서드는 `MiniDbError`가 아닌 예외를 `InternalError INVARIANT_VIOLATION`(원인 보존)으로 감싸고 FAILED | 테스트 하네스의 `SimulatedCrash`는 예외(그대로 전파) | 없음 |
| DC-52 | 락 파일 | `<db>-lock`을 배타 생성(`wx`)하고 `pid\n` 기록. 이미 있으면 PID 읽기: 파싱 불가 → 잠김. 같은 PID 또는 `process.kill(pid, 0)` 성공/EPERM → 잠김(`StorageError DB_LOCKED`). ESRCH → stale로 보고 삭제 후 1회 재시도. 같은 프로세스 이중 오픈은 정규화된 경로의 모듈 레지스트리로 먼저 차단. close 시 삭제(삭제 실패는 무시) | 협력적 잠금일 뿐 OS 잠금 아님 | 없음 |
| DC-53 | 디렉터리 fsync | 데이터/WAL 파일을 **새로 만든 경우**에만 부모 디렉터리 fsync(F1). POSIX: 실패가 EINVAL/ENOTSUP/EISDIR면 미지원으로 기록하고 계속, 그 외 오류 → `StorageError IO_ERROR`. Windows: 디렉터리 fsync를 수행하지 않음(Node로 디렉터리 핸들 fsync 불가), `stats.io.dirSyncs` 0 | WAL 리셋은 truncate라 디렉터리 변경 없음 | 없음 |
| DC-69 | 줄바꿈 | `.gitattributes`: `*.sql`, `*.expected`, `*.md`, `*.ts` → `eol=lf`. 렉서는 `\r`을 공백 취급. 골든 비교 전 CRLF→LF 정규화 | | 없음 |

#### 오류·출력·API

| ID | 영역 | 확정 규칙 | 예시·경계 | 번복 조건 |
|---|---|---|---|---|
| DC-54 | 오류 체계 | `MiniDbError` 기반, 하위: `SqlSyntaxError`, `SemanticError`, `ConstraintError`, `TransactionError`, `LimitError`, `StorageError`, `CorruptionError`, `InternalError`, `UsageError`. 코드 목록은 H.2가 전부 | 코드 형식 `^[A-Z][A-Z0-9_]*$` | 없음 |
| DC-55 | 위치 | `{ offset, line, column }`, 1부터. `\n`만 줄 구분. column은 **코드 포인트** 단위 | 탭은 1칸 | 없음 |
| DC-56 | EXPLAIN | F.10 형식(결정적, 들여쓰기 2칸) | | 없음 |
| DC-57 | CLI | F.12 | 종료 코드 0/1/2/3 | 없음 |
| DC-58 | 진단 API | `db.stats()`/`db.resetStats()`/`db.integrityCheck()`는 E.4 형식. `integrityCheck()`와 `checkpoint()`는 명시적 트랜잭션 중 → `TransactionError TXN_ACTIVE` | | 없음 |
| DC-59 | 실행 API | `execute(sql, opts?)`는 정확히 1문장(끝 `;` 선택). 0문장 → `SYNTAX_EMPTY_STATEMENT`, 2문장 이상 → `SYNTAX_MULTIPLE_STATEMENTS`. `executeScript(sql)`은 문장 배열을 순서대로 실행하고 첫 오류에서 중단(오류에 `statementIndex` 부여, 이전 문장 효과는 유지). 옵션 `{ forceSeqScan?: boolean }`(테스트·학습용) | | 없음 |

#### 개발 절차

| ID | 영역 | 확정 규칙 | 예시·경계 | 번복 조건 |
|---|---|---|---|---|
| DC-66 | 결정성 | PRNG는 `sfc32`(seed는 splitmix32로 확장), `src/util/prng.ts`. `src/`와 `tests/`에서 `Math.random` 금지, `src/`에서 `Date.now`/`new Date` 금지(벤치마크 하네스 제외) | 같은 seed → 같은 결과 | 없음 |
| DC-67 | 단계 순서 | M의 P0~P17 | | C.1.8 |

---

## D. On-disk Format

### D.0 공통 규칙

- 파일: 데이터 파일 `<path>`, WAL `<path>-wal`, 락 `<path>-lock`(텍스트 `pid\n`, 체크섬 없음).
- 페이지 크기 `PAGE_SIZE = 4096`. 페이지 p의 데이터 파일 오프셋 = `p × 4096`.
- 정수는 표에 따로 적지 않으면 **부호 없는 리틀 엔디안**(u8/u16/u32). `i64`는 2의 보수 리틀 엔디안.
- "예약" 필드는 쓸 때 0으로 쓰고 v1 리더는 값을 해석하지 않는다(CRC가 변조를 잡는다).
- CRC32는 DC-08 정의. "페이지 CRC"는 4096바이트 전체를 offset 4..8을 0으로 간주하고 계산한 값.
- 사용하지 않는 바이트(slot 디렉터리와 레코드 영역 사이 등)는 0으로 쓸 의무가 없다(CRC 범위에는 포함). 단 **새로 초기화한 페이지는 전부 0에서 시작**한다(결정적 바이트, T-FMT-002).

### D.1 공통 페이지 헤더 (모든 페이지, 16바이트)

| 오프셋 | 크기 | 타입 | 필드 | 규칙 |
|---|---|---|---|---|
| 0 | 1 | u8 | `pageType` | 1=HEADER, 2=HEAP, 3=BTREE_INTERNAL, 4=BTREE_LEAF, 5=FREE. 그 외 → `CorruptionError PAGE_TYPE_INVALID` |
| 1 | 1 | u8 | `flags` | 0 (예약) |
| 2 | 2 | u16 | 예약 | 0 |
| 4 | 4 | u32 | `crc32` | 페이지 CRC. 불일치 → `PAGE_CHECKSUM_MISMATCH` |
| 8 | 4 | u32 | `pageId` | 자기 페이지 번호. 불일치 → `PAGE_ID_MISMATCH`(잘못된 위치에 쓴 페이지 탐지) |
| 12 | 4 | u32 | 예약 | 0 |

검증 순서(물리 읽기마다): CRC → pageId → pageType. Page 0은 CRC보다 **magic을 먼저** 검사한다(아무 파일이나 열었을 때 `NOT_A_DATABASE`를 내기 위해).

### D.2 Page 0 — 파일 헤더 (pageType = 1)

| 오프셋 | 크기 | 타입 | 필드 | 규칙 |
|---|---|---|---|---|
| 0 | 16 | — | 공통 헤더 | pageType=1, pageId=0 |
| 16 | 8 | bytes | `magic` | `4D 49 4E 49 44 42 00 00` |
| 24 | 2 | u16 | `formatVersion` | 1 |
| 26 | 2 | u16 | `pageSize` | 4096 |
| 28 | 4 | u32 | `pageCount` | 논리 페이지 수(Page 0 포함). ≥ 2 |
| 32 | 4 | u32 | `freelistHead` | 첫 FREE 페이지, 0 = 비어 있음 |
| 36 | 4 | u32 | `freelistCount` | freelist 길이 |
| 40 | 4 | u32 | `catalogRoot` | 1 (Pager는 해석하지 않음, 엔진이 검증) |
| 44 | 4 | u32 | 예약 | 0 |
| 48 | 8 | bytes | `dbId` | 생성 시 entropy 8바이트 |
| 56 | 4040 | — | 예약 | 0 |

- 오픈 시 검사: magic → `formatVersion`(≠1 → `UNSUPPORTED_FORMAT_VERSION`) → `pageSize`(≠4096 → `UNSUPPORTED_FORMAT_VERSION`) → CRC → `pageCount ≥ 2` → 데이터 파일 크기 ≥ `pageCount × 4096`(아니면 `FILE_TRUNCATED`).
- 데이터 파일 크기가 `pageCount × 4096`보다 크면 오픈은 진행, `integrityCheck`가 `FILE_SIZE_MISMATCH` 보고.

### D.3 HEAP 페이지 (pageType = 2) — slotted page

| 오프셋 | 크기 | 타입 | 필드 | 규칙 |
|---|---|---|---|---|
| 0 | 16 | — | 공통 헤더 | |
| 16 | 2 | u16 | `slotCount` | slot 디렉터리 항목 수 |
| 18 | 2 | u16 | `recordStart` | 레코드 영역 시작(가장 낮은 레코드 오프셋). 빈 페이지 = 4096 |
| 20 | 4 | u32 | `nextPage` | 체인의 다음 HEAP 페이지, 0 = 끝 |
| 24 | 4 | u32 | `tailPage` | **head 페이지에서만** 체인의 마지막 페이지(자기 자신일 수 있음). 그 외 페이지 = 0 |
| 28 | 2 | u16 | `fragmentedBytes` | 레코드 영역 안의 사용되지 않는 바이트 합 |
| 30 | 2 | u16 | 예약 | 0 |
| 32 | 4·slotCount | — | slot 디렉터리 | slot i at `32 + 4i`: u16 `offset`, u16 `length` |
| … | | | 빈 공간 | `[32 + 4·slotCount, recordStart)` |
| recordStart | | | 레코드 영역 | `[recordStart, 4096)` |

- tombstone = `offset = 0, length = 0`. 살아 있는 slot은 `length ≥ 1`, `offset ≥ recordStart`, `offset + length ≤ 4096`.
- 마지막 slot은 tombstone일 수 없다(삭제 후 꼬리 tombstone을 잘라냄).
- 공간 공식: `slotDirEnd = 32 + 4·slotCount`, `contiguousFree = recordStart − slotDirEnd`, `totalFree = contiguousFree + fragmentedBytes`, 불변식 `fragmentedBytes = (4096 − recordStart) − Σ live length`.
- 한 페이지 최대 행: `4096 − 32 − 4 = 4060` = MAX_ROW_BYTES.

### D.4 행(레코드) 인코딩

스키마(컬럼 수 n, 컬럼 타입 순서)는 카탈로그에서 오며 레코드에는 타입 태그가 없다.

| 오프셋 | 크기 | 필드 | 규칙 |
|---|---|---|---|
| 0 | 1 | `columnCount` u8 | = n (1~64). 스키마와 다르면 `RECORD_MALFORMED` |
| 1 | ⌈n/8⌉ | null 비트맵 | 컬럼 i는 바이트 `i >> 3`의 비트 `i & 7`(LSB 우선). 1 = NULL. 사용하지 않는 상위 비트는 0이어야 함 |
| 1+⌈n/8⌉ | 가변 | 필드들 | NULL이 아닌 컬럼만 컬럼 순서대로 |

| 타입 | 인코딩 | 디코딩 실패 조건 (`RECORD_MALFORMED`) |
|---|---|---|
| INTEGER | i64 LE 8바이트 | 안전 정수 범위 밖 |
| BOOLEAN | u8: 0 = FALSE, 1 = TRUE | 0/1 외 값 |
| TEXT | u16 LE 바이트 길이 L + UTF-8 L바이트 | L > 4000, 잘못된 UTF-8(`TextDecoder('utf-8', { fatal: true })`) |

- 레코드 길이 = slot `length`와 정확히 일치해야 한다(남는 바이트·부족 → `RECORD_MALFORMED`).
- 크기 공식: `1 + ⌈n/8⌉ + Σ(INTEGER 8, BOOLEAN 1, TEXT 2 + L)`.
- 예: `(id INTEGER, name TEXT, ok BOOLEAN)` = `(7, '한', NULL)` → `03 | 04 | 07 00 00 00 00 00 00 00 | 03 00 ED 95 9C` = 15바이트.

### D.5 FREE 페이지 (pageType = 5)

| 오프셋 | 크기 | 필드 | 규칙 |
|---|---|---|---|
| 0 | 16 | 공통 헤더 | |
| 16 | 4 | `nextFree` u32 | 다음 FREE 페이지, 0 = 끝 |
| 20 | 4076 | 0 | 해제 시 페이지 전체를 0으로 초기화 후 헤더 기록 |

- freelist = 헤더 `freelistHead`에서 시작하는 단일 연결 리스트(LIFO). 할당: head를 꺼냄. 해제: 해제 페이지를 새 head로.

### D.6 B+tree 노드 (pageType = 3 내부, 4 리프)

| 오프셋 | 크기 | 타입 | 필드 | 규칙 |
|---|---|---|---|---|
| 0 | 16 | — | 공통 헤더 | |
| 16 | 2 | u16 | `cellCount` | |
| 18 | 2 | u16 | `cellStart` | 셀 영역 시작(빈 노드 = 4096) |
| 20 | 4 | u32 | `rightPtr` | 내부: 가장 오른쪽 자식. 리프: 다음 리프(0 = 마지막) |
| 24 | 2 | u16 | `fragmentedBytes` | |
| 26 | 2 | u16 | 예약 | 0 |
| 28 | 4 | u32 | 예약 | 0 |
| 32 | 2·cellCount | — | 셀 포인터 배열 | u16 셀 오프셋, **키 순서대로 정렬** |
| … | | | 빈 공간 / 셀 영역 | heap과 동일한 공간 공식(slot 4바이트 대신 포인터 2바이트) |

리프 셀:

| 오프셋(셀 기준) | 크기 | 필드 |
|---|---|---|
| 0 | 2 | `keyLen` u16 (0~512) |
| 2 | keyLen | `key` |
| 2+keyLen | 4 | `rid.pageId` u32 |
| 6+keyLen | 2 | `rid.slot` u16 |

내부 셀(separator):

| 오프셋(셀 기준) | 크기 | 필드 |
|---|---|---|
| 0 | 4 | `leftChild` u32 |
| 4 | 2 | `keyLen` u16 |
| 6 | keyLen | `key` |
| 6+keyLen | 4 | `rid.pageId` u32 |
| 10+keyLen | 2 | `rid.slot` u16 |

- 의미: 내부 셀 i의 `leftChild` 서브트리 항목은 `sep_{i−1} ≤ e < sep_i`, `rightPtr` 서브트리는 `e ≥ sep_last`(비교는 DC-28 비교기).
- 최대 셀: 리프 2+512+6 = 520(+포인터 2), 내부 4+2+512+6 = 524(+2). 가용 4064바이트 → 노드당 최소 7셀.

키 인코딩(컬럼 하나, 타입 태그 없음):

| 타입 | 키 바이트 | 예 |
|---|---|---|
| INTEGER | 8바이트 **빅 엔디안**, 값의 int64 2의 보수에서 부호 비트 반전(= `value + 2^63`을 u64 BE로) | −1 → `7F FF FF FF FF FF FF FF`, 0 → `80 00 00 00 00 00 00 00`, 1 → `80 … 01` |
| BOOLEAN | 1바이트: `00` = FALSE, `01` = TRUE | |
| TEXT | UTF-8 원본 바이트(0~512) | `''` → 길이 0 키 |

`compareBytes(a, b)`: 공통 길이까지 바이트별 비교, 같으면 짧은 쪽이 작음.

### D.7 카탈로그 (`mdb_catalog`, Page 1 head의 HEAP 체인)

레코드는 D.4 코덱과 아래 고정 스키마(10 컬럼)를 사용한다.

| # | 컬럼 | 타입 | table 행 | column 행 | index 행 |
|---|---|---|---|---|---|
| 0 | `kind` | TEXT NOT NULL | `'table'` | `'column'` | `'index'` |
| 1 | `name` | TEXT NOT NULL | 테이블 이름 | 컬럼 이름 | 인덱스 이름 |
| 2 | `table_name` | TEXT NOT NULL | 테이블 이름 | 소속 테이블 | 대상 테이블 |
| 3 | `position` | INTEGER NOT NULL | 컬럼 수 | 0부터의 순번 | 0 |
| 4 | `data_type` | TEXT | NULL | `'INTEGER'`/`'TEXT'`/`'BOOLEAN'` | NULL |
| 5 | `not_null` | BOOLEAN | NULL | TRUE/FALSE | NULL |
| 6 | `primary_key` | BOOLEAN | NULL | TRUE/FALSE | NULL |
| 7 | `is_unique` | BOOLEAN | NULL | NULL | TRUE/FALSE |
| 8 | `root_page` | INTEGER | 힙 head 페이지 | NULL | B+tree 루트 페이지 |
| 9 | `column_name` | TEXT | NULL | NULL | 색인 컬럼 이름 |

- CREATE TABLE이 쓰는 행 순서: table 행 → column 행(순번 순) → (PK가 있으면) `mdb_pk_<table>` index 행(`is_unique = TRUE`).
- 적재 시 검증(위반 → `CorruptionError CATALOG_INVALID`): kind 값, 이름 정규화·식별자 규칙, 테이블별 column 행이 0..n−1 연속이고 n = table 행 `position`, primary_key 컬럼 ≤ 1이고 그 컬럼은 not_null, PK 테이블에는 `mdb_pk_<table>` 유일 인덱스가 그 컬럼에 존재, 이름 공간 중복 없음, 인덱스 대상 테이블·컬럼 존재, `root_page` < pageCount이고 타입 일치(테이블 → HEAP head, 인덱스 → BTREE_*).

### D.8 WAL 파일 (`<path>-wal`)

WAL 헤더(48바이트, 오프셋 0):

| 오프셋 | 크기 | 타입 | 필드 | 규칙 |
|---|---|---|---|---|
| 0 | 4 | bytes | `magic` | `4D 44 42 57` ("MDBW") |
| 4 | 2 | u16 | `walVersion` | 1 |
| 6 | 2 | u16 | 예약 | 0 |
| 8 | 4 | u32 | `pageSize` | 4096 |
| 12 | 4 | u32 | `checkpointSeq` | 리셋마다 +1 (생성 시 1) |
| 16 | 8 | bytes | `dbId` | 데이터 파일 헤더와 같아야 함 |
| 24 | 4 | u32 | `salt1` | 리셋마다 entropy |
| 28 | 4 | u32 | `salt2` | 리셋마다 entropy |
| 32 | 12 | — | 예약 | 0 |
| 44 | 4 | u32 | `headerCrc` | CRC32(bytes[0..44)) |

프레임(4120바이트, 프레임 k 오프셋 = 48 + 4120·k):

| 오프셋 | 크기 | 타입 | 필드 | 규칙 |
|---|---|---|---|---|
| 0 | 4 | u32 | `pageId` | < 커밋 후 pageCount |
| 4 | 4 | u32 | `flags` | bit0 = COMMIT. 다른 비트 ≠ 0 → 프레임 무효(스캔 중단) |
| 8 | 4 | u32 | `salt1` | 헤더와 같아야 함 |
| 12 | 4 | u32 | `salt2` | 헤더와 같아야 함 |
| 16 | 4 | u32 | `checksum` | `CRC32(LE32(prev) ‖ frame[0..16) ‖ page[0..4096))`, prev = 직전 프레임 checksum, 첫 프레임은 `headerCrc` |
| 20 | 4 | u32 | 예약 | 0이 아니면 프레임 무효 |
| 24 | 4096 | — | 페이지 이미지 | 페이지 CRC가 계산된 완전한 이미지 |

- 빈 WAL: 크기가 정확히 48이고 헤더 유효. 헤더 무효 ∧ 크기 ≤ 48 → 빈 WAL로 간주(리셋 도중 크래시). 헤더 무효 ∧ 크기 > 48 → `WAL_HEADER_INVALID`.
- 트랜잭션 = 연속 프레임들, 마지막 프레임만 COMMIT. 같은 트랜잭션 안에 같은 pageId는 1번.
- 최신 이미지 규칙: 여러 커밋된 트랜잭션에 같은 pageId가 있으면 뒤의 것이 이긴다.

### D.9 포맷 버전 정책

1. 데이터 파일 `formatVersion`과 WAL `walVersion`은 독립적이며 v1은 둘 다 1.
2. D.1~D.8의 어떤 바이트 의미든 바뀌면(필드 추가가 예약 영역을 쓰는 경우 포함) 해당 버전을 올린다.
3. v1 구현은 다른 버전을 읽지도 고치지도 않는다(`UNSUPPORTED_FORMAT_VERSION`). 마이그레이션 도구는 범위 밖.
4. 포맷 안정성 테스트: 고정 entropy로 만든 빈 DB의 바이트를 `tests/fixtures/empty-v1.db`(8192바이트)와 비교(T-FMT-002). 이 픽스처가 바뀌는 커밋은 반드시 버전 정책 검토를 DECISIONS에 남긴다.
5. `FORMAT.md`는 이 섹션의 표를 그대로 옮기고, 코드의 오프셋 상수는 한 파일(`src/storage/layout.ts`)에만 정의한다.

---

## E. Architecture

### E.1 모듈과 책임

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

### E.2 의존 방향 (단방향, T-ARCH-001이 import를 검사)

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

### E.3 데이터 흐름

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

### E.4 핵심 인터페이스 (타입 시그니처 수준)

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

### E.5 디렉터리 구조

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

---

## F. SQL Front-end & Execution

### F.1 어휘 규칙과 토큰

| 토큰 | 규칙 |
|---|---|
| 공백 | U+0020, `\t`, `\n`, `\r`. `\n`만 줄을 바꾼다 |
| 주석 | `--`부터 `\n` 또는 입력 끝까지. 따라서 `5--3`은 `5` 뒤 주석이다 |
| `KEYWORD` | 대소문자 무시, 전부 예약어: `AND ASC BEGIN BOOLEAN BY COMMIT CREATE DELETE DESC DROP EXPLAIN FALSE FROM INDEX INSERT INTEGER INTO IS KEY LIMIT NOT NULL OFFSET ON OR ORDER PRIMARY ROLLBACK SELECT SET TABLE TEXT TRUE UNIQUE UPDATE VALUES WHERE` (37개) |
| `IDENT` | `[A-Za-z_][A-Za-z0-9_]*` 중 키워드가 아닌 것, 소문자로 정규화. 64바이트 초과 → `LimitError IDENTIFIER_TOO_LONG` |
| `INTEGER` | `[0-9]+`. 값 > 9007199254740991 → `LimitError INTEGER_OUT_OF_RANGE`. 바로 뒤에 `[A-Za-z_]`가 오면 `SqlSyntaxError SYNTAX_INVALID_NUMBER` |
| `STRING` | `'` … `'`, 내부 `''` = 작은따옴표 1개. 줄바꿈 포함 가능. 닫히지 않음 → `SYNTAX_UNTERMINATED_STRING`(여는 따옴표 위치). lone surrogate 포함 → `SYNTAX_INVALID_STRING`. UTF-8 길이 > 4000 → `LimitError TEXT_TOO_LARGE` |
| 구두점 | `(` `)` `,` `;` `*` `+` `-` `=` `<>` `!=` `<` `<=` `>` `>=` |
| `EOF` | 입력 끝 |
| 기타 문자 | `SqlSyntaxError SYNTAX_INVALID_CHARACTER` |

모든 토큰은 시작 위치 `{offset, line, column}`을 가진다(DC-55).

### F.2 EBNF (SPEC.md의 문법 원본)

```ebnf
script            = [ statement ] , { ";" , [ statement ] } ;
statement         = select_stmt | explain_stmt | insert_stmt | update_stmt | delete_stmt
                  | create_table_stmt | drop_table_stmt | create_index_stmt | drop_index_stmt
                  | "BEGIN" | "COMMIT" | "ROLLBACK" ;

explain_stmt      = "EXPLAIN" , select_stmt ;
select_stmt       = "SELECT" , select_list , "FROM" , IDENT ,
                    [ "WHERE" , expr ] ,
                    [ "ORDER" , "BY" , order_item , { "," , order_item } ] ,
                    [ "LIMIT" , INTEGER , [ "OFFSET" , INTEGER ] ] ;
select_list       = "*" | IDENT , { "," , IDENT } ;
order_item        = IDENT , [ "ASC" | "DESC" ] ;

insert_stmt       = "INSERT" , "INTO" , IDENT , [ "(" , IDENT , { "," , IDENT } , ")" ] ,
                    "VALUES" , value_row , { "," , value_row } ;
value_row         = "(" , expr , { "," , expr } , ")" ;
update_stmt       = "UPDATE" , IDENT , "SET" , assignment , { "," , assignment } , [ "WHERE" , expr ] ;
assignment        = IDENT , "=" , expr ;
delete_stmt       = "DELETE" , "FROM" , IDENT , [ "WHERE" , expr ] ;

create_table_stmt = "CREATE" , "TABLE" , IDENT , "(" , column_def , { "," , column_def } , ")" ;
column_def        = IDENT , type_name , { column_constraint } ;
type_name         = "INTEGER" | "TEXT" | "BOOLEAN" ;
column_constraint = "NOT" , "NULL" | "PRIMARY" , "KEY" ;
drop_table_stmt   = "DROP" , "TABLE" , IDENT ;
create_index_stmt = "CREATE" , [ "UNIQUE" ] , "INDEX" , IDENT , "ON" , IDENT , "(" , IDENT , ")" ;
drop_index_stmt   = "DROP" , "INDEX" , IDENT ;

expr              = or_expr ;
or_expr           = and_expr , { "OR" , and_expr } ;
and_expr          = not_expr , { "AND" , not_expr } ;
not_expr          = "NOT" , not_expr | cmp_expr ;
cmp_expr          = add_expr , [ cmp_op , add_expr | "IS" , [ "NOT" ] , "NULL" ] ;
cmp_op            = "=" | "<>" | "!=" | "<" | "<=" | ">" | ">=" ;
add_expr          = mul_expr , { ( "+" | "-" ) , mul_expr } ;
mul_expr          = unary_expr , { "*" , unary_expr } ;
unary_expr        = "-" , unary_expr | primary ;
primary           = INTEGER | STRING | "TRUE" | "FALSE" | "NULL" | IDENT | "(" , expr , ")" ;
```

- `execute()`는 `script`가 정확히 1개의 statement를 가질 때만 허용(DC-59). 빈 statement(`;;`)는 `executeScript`에서 건너뛴다.
- 같은 column_constraint 반복(`NOT NULL NOT NULL`) → `SemanticError DUPLICATE_CONSTRAINT`.

### F.3 연산자 우선순위 (높음 → 낮음)

| 단계 | 연산자 | 결합 |
|---|---|---|
| 1 | 리터럴, 컬럼, `( … )` | — |
| 2 | 단항 `-` | 오른쪽 (`- -5` 허용) |
| 3 | `*` | 왼쪽 |
| 4 | `+` `-` | 왼쪽 |
| 5 | `= <> != < <= > >=`, `IS [NOT] NULL` | **비결합**: `a = b = c`, `a = b IS NULL` → `SYNTAX_UNEXPECTED_TOKEN` |
| 6 | `NOT` | 오른쪽(전위). `NOT a = b` = `NOT (a = b)` |
| 7 | `AND` | 왼쪽 |
| 8 | `OR` | 왼쪽 |

구현: `parseExpr(minPrec)` precedence climbing, 위 표가 유일한 근거.

### F.4 타입 규칙

정적 타입 집합: `INTEGER`, `TEXT`, `BOOLEAN`, `NULLTYPE`(NULL 리터럴 및 NULLTYPE만으로 된 연산의 타입).

| 식 | 피연산자 조건 | 결과 타입 | 위반 시 |
|---|---|---|---|
| 정수/문자열/TRUE·FALSE/NULL 리터럴 | — | INTEGER / TEXT / BOOLEAN / NULLTYPE | |
| 컬럼 참조 | 테이블에 존재 | 컬럼 타입 | `COLUMN_NOT_FOUND` |
| 단항 `-` | INTEGER 또는 NULLTYPE | INTEGER | `TYPE_MISMATCH` |
| `+ - *` | 양쪽 각각 INTEGER 또는 NULLTYPE | INTEGER | `TYPE_MISMATCH` |
| 비교 6종 | 같은 타입이거나 한쪽 이상 NULLTYPE (BOOLEAN끼리도 6종 모두 허용, FALSE < TRUE) | BOOLEAN | `TYPE_MISMATCH` |
| `AND` `OR` `NOT` | BOOLEAN 또는 NULLTYPE | BOOLEAN | `TYPE_MISMATCH` |
| `IS [NOT] NULL` | 아무 타입 | BOOLEAN (값은 NULL이 될 수 없음) | |
| `WHERE` 조건 | BOOLEAN 또는 NULLTYPE | — | `TYPE_MISMATCH` |
| INSERT 값 / SET 값 | 컬럼 타입과 같거나 NULLTYPE | — | `TYPE_MISMATCH` |

### F.5 NULL 3값 논리와 평가 규칙

`T`=TRUE, `F`=FALSE, `U`=UNKNOWN(NULL).

| a | b | a AND b | a OR b |
|---|---|---|---|
| T | T | T | T |
| T | F | F | T |
| T | U | U | T |
| F | T | F | T |
| F | F | F | F |
| F | U | F | U |
| U | T | U | T |
| U | F | F | U |
| U | U | U | U |

| a | NOT a | a IS NULL | a IS NOT NULL |
|---|---|---|---|
| T | F | F | T |
| F | T | F | T |
| U | U | T | F |

- 비교·산술에서 한쪽이라도 NULL이면 결과 NULL. `NULL = NULL` → U.
- **단락 평가**: `AND`는 왼쪽이 F면 오른쪽을 평가하지 않고 F. `OR`는 왼쪽이 T면 평가하지 않고 T. 그 외에는 왼쪽 → 오른쪽 순서로 둘 다 평가.
- 산술 피연산자는 왼쪽 → 오른쪽 평가. 각 연산 결과 범위 검사(DC-35). 판정은 `Number.isSafeInteger(result)`.
- WHERE는 결과가 T인 행만 통과.
- 정렬 비교: INTEGER 수치, TEXT UTF-8 바이트(DC-39), BOOLEAN F < T, NULL 최소(DC-34).

### F.6 평가(논리 처리) 순서

`SELECT`: FROM(스캔) → WHERE → ORDER BY → OFFSET/LIMIT → SELECT 목록(투영).
`UPDATE`: 대상 수집(WHERE, 옛 행 기준) → 모든 대상의 SET 식을 **옛 행 기준으로 동시 평가**(`SET a = b, b = a`는 교환) → 검사 → 적용.
`DELETE`: 대상 수집 → 적용.
`INSERT`: VALUES 행 순서대로, 행 하나를 완전히(검사 → 힙 → 인덱스) 끝낸 뒤 다음 행.

### F.7 분석 단계 검사 목록 (모두 실행 전, 상태 변경 없음)

| # | 검사 | 오류 |
|---|---|---|
| A1 | 참조 테이블 존재 (SELECT/INSERT/UPDATE/DELETE/DROP TABLE/CREATE INDEX) | `TABLE_NOT_FOUND` |
| A2 | 참조 인덱스 존재 (DROP INDEX) | `INDEX_NOT_FOUND` |
| A3 | 컬럼 존재 (SELECT 목록, WHERE, ORDER BY, INSERT 컬럼 목록, SET 대상, CREATE INDEX) | `COLUMN_NOT_FOUND` |
| A4 | F.4 타입 규칙 | `TYPE_MISMATCH` |
| A5 | CREATE TABLE/INDEX 이름이 테이블·인덱스 이름 공간에 없음 | `OBJECT_EXISTS` |
| A6 | 이름이 `mdb_`로 시작하지 않음 | `RESERVED_NAME` |
| A7 | CREATE TABLE 컬럼 이름 중복 없음 | `DUPLICATE_COLUMN` |
| A8 | PRIMARY KEY 컬럼 ≤ 1 | `MULTIPLE_PRIMARY_KEYS` |
| A9 | 컬럼 수 ≤ 64 | `LimitError TOO_MANY_COLUMNS` |
| A10 | 같은 제약 반복 없음 | `DUPLICATE_CONSTRAINT` |
| A11 | INSERT 컬럼 목록 중복 없음 / UPDATE SET 대상 중복 없음 | `DUPLICATE_COLUMN` |
| A12 | INSERT 각 행 값 개수 = 대상 컬럼 수 | `COLUMN_COUNT_MISMATCH` |
| A13 | INSERT 값에 컬럼 참조 없음 | `NOT_CONSTANT` |
| A14 | DROP INDEX 대상이 자동 PK 인덱스가 아님 | `CANNOT_DROP_PK_INDEX` |

검사 순서는 문장 구문 순서(왼쪽 → 오른쪽)이며 첫 위반에서 중단. 오류 위치 = 위반 토큰.

### F.8 플래너 규칙 (규칙 기반, 결정적)

입력: Bound SELECT/UPDATE/DELETE, 옵션 `forceSeqScan`.

1. WHERE가 없거나 `forceSeqScan`이면 `SeqScan`.
2. WHERE를 최상위 `AND`로 평탄화해 conjunct 목록을 만든다(`OR`, `NOT` 내부로 들어가지 않음).
3. **인덱스 가능 conjunct**: `col op c` 또는 `c op col`(뒤쪽은 연산자를 뒤집어 정규화), `op ∈ {=, <, <=, >, >=}`, `col`에 인덱스가 하나 이상 있음, `c`는 NULL이 아닌 리터럴 또는 `-정수리터럴`. (`<>`, `!=`, `IS NULL`, 컬럼끼리 비교, 그 밖의 식은 불가.)
4. 인덱스 선택 우선순위: (a) `=` conjunct가 있는 **유일** 인덱스, (b) `=` conjunct가 있는 비유일 인덱스, (c) 범위 conjunct가 있는 인덱스. 같은 순위에서는 **인덱스 이름 오름차순** 첫 번째.
5. 선택한 인덱스 컬럼의 모든 인덱스 가능 conjunct로 범위를 계산: `=` → `[c, c]`. 하한은 가장 큰 값, 같은 값이면 배타가 이김. 상한은 가장 작은 값, 같은 값이면 배타가 이김. `=`가 여러 개고 값이 다르면 빈 범위(하한 > 상한)가 되어 결과 0행.
6. 플랜: `IndexScan(range)` + **WHERE 전체**를 담은 `Filter`(DC-70).
7. SELECT 플랜 모양(위에서 아래로): `Project` → `Limit`(있으면) → `Sort`(ORDER BY가 있으면) → `Filter`(WHERE가 있으면) → `SeqScan` | `IndexScan`.
8. UPDATE/DELETE 플랜: `Filter`(있으면) → `SeqScan` | `IndexScan`. 그 위에서 DML 연산자가 대상을 수집.

### F.9 연산자별 동작

| 연산자 | open | next | close | 비고 |
|---|---|---|---|---|
| `SeqScan(table)` | 커서를 (head, slot 0)에 | 체인을 따라 다음 살아 있는 slot의 행 복사본 반환 | — | pin을 `next()` 사이에 보유하지 않음 |
| `IndexScan(table, index, range)` | B+tree 커서를 하한에 seek | 다음 항목 → 범위 밖이면 끝 → RID로 힙 행 조회(없으면 `CorruptionError INDEX_HEAP_MISMATCH`) | — | 키 순서 반환 |
| `Filter(pred)` | child.open | T인 행이 나올 때까지 child.next | child.close | |
| `Sort(keys)` | child 전체 수집 후 안정 정렬 | 배열 순회 | 배열 해제 | 메모리 정렬 |
| `Limit(n, m)` | n = 0이면 child를 열지 않음 | 처음 m행 버림, n행 반환 후 끝 | | |
| `Project(cols)` | | 선택 컬럼만 새 배열로 | | `*`는 테이블 순서 전체 |
| `Insert` / `Update` / `Delete` | G.14 절차 | — | — | 결과 `changes` |

- 반환하는 행 값은 복사본이다(페이지 버퍼 뷰 금지).
- 연산자 `close()`는 오류 경로에서도 `finally`로 호출한다.

### F.10 EXPLAIN 형식

- 결과: `{ kind: 'rows', columns: ['plan'], rows: [[line], …] }`, 한 줄 = 플랜 노드 하나, 루트부터 전위 순회, 깊이마다 공백 2칸.
- 노드 형식(정확히):

| 노드 | 줄 형식 |
|---|---|
| Project | `Project columns=<c1>, <c2>, …` |
| Limit | `Limit limit=<n> offset=<m>` (OFFSET 생략 시 0) |
| Sort | `Sort keys=<c1> ASC, <c2> DESC` |
| Filter | `Filter predicate=<expr>` |
| SeqScan | `SeqScan table=<t>` |
| IndexScan | `IndexScan table=<t> index=<i> column=<c> range=<lb><lo>, <hi><ub>` |

- 범위 표기: `<lb>`는 `[`(포함) 또는 `(`(배타), `<ub>`는 `]` 또는 `)`. 무한은 `-inf`/`+inf`이고 항상 배타 괄호. 예: `range=[30, +inf)`, `range=[5, 5]`, `range=(-inf, 10)`.
- 식 표기(`sql/printer.ts`): 이항식 `(<l> <op> <r>)`(`!=`는 `<>`로), `(NOT <e>)`, `(-<e>)`, `(<e> IS NULL)`, `(<e> IS NOT NULL)`, 정수는 10진, 문자열은 `'…'`(내부 `'`는 `''`), `TRUE`/`FALSE`/`NULL`, 컬럼은 정규화 이름.
- 예:

```text
EXPLAIN SELECT name FROM users WHERE age >= 30 AND name <> 'x' ORDER BY name LIMIT 10

Project columns=name
  Limit limit=10 offset=0
    Sort keys=name ASC
      Filter predicate=((age >= 30) AND (name <> 'x'))
        IndexScan table=users index=idx_age column=age range=[30, +inf)
```

### F.11 결과 형태

| 문장 | ExecResult |
|---|---|
| SELECT, EXPLAIN | `rows` (컬럼 이름 = 정규화된 컬럼 이름, 0행이어도 columns 채움) |
| INSERT | `changes` = 삽입 행 수 |
| UPDATE | `changes` = 대상 행 수(값이 안 바뀌어도 셈) |
| DELETE | `changes` = 삭제 행 수 |
| DDL, BEGIN/COMMIT/ROLLBACK | `ok` + command 태그 |

### F.12 CLI

- 사용법: `minidb <file> [-c <sql> | -f <script.sql>]`, `minidb --help`.
- 모드: `-c` → `executeScript(sql)`; `-f` → 파일 내용을 `executeScript`; 둘 다 없으면 REPL. `-c`와 `-f` 동시 → 사용법 오류.
- REPL: 프롬프트 `minidb> `, 이어지는 줄 `   ...> `. 입력을 누적하다가 문자열·주석 밖의 `;`로 끝나면 실행. 줄이 `.`으로 시작하고 누적 입력이 비어 있으면 도트 명령.
- 도트 명령: `.help`, `.tables`(이름순 한 줄씩), `.schema [table]`(정규화된 CREATE 문: 테이블 이름순, 각 테이블 뒤에 자동이 아닌 인덱스 이름순), `.indexes [table]`, `.stats`(`JSON.stringify(stats, null, 2)`), `.integrity`(`ok` 또는 이슈마다 `CODE page=<n|-> object=<name|-> <message>`), `.checkpoint`, `.quit`/`.exit`. 모르는 명령 → `Error: unknown command .xyz`.
- 출력 형식(결정적):
  - rows: 첫 줄 컬럼 이름을 ` | `로 연결, 이어서 각 행을 같은 구분자로. NULL은 `NULL`, BOOLEAN은 `TRUE`/`FALSE`, TEXT는 원문 그대로. 마지막 줄 `(N rows)`, N=1이면 `(1 row)`.
  - changes: `INSERT 3`, `UPDATE 0`, `DELETE 2`.
  - ok: command 태그 그대로(`CREATE TABLE`, `BEGIN` …).
  - 오류: stderr에 `err.format()`(H.3).
- 종료 코드: `0` 성공 / `1` SQL 문장 오류(`-c`/`-f`는 첫 오류에서 중단) / `2` 사용법 오류 / `3` 오픈 실패(락·손상·I/O) 또는 종료 시 핸들이 FAILED. REPL에서 문장 오류는 출력 후 계속하고 종료 코드에 영향 없음.
- 구현: `runCli(argv: string[], io: { stdin: string | AsyncIterable<string>; stdout: (s: string) => void; stderr: (s: string) => void }): Promise<number>` — 테스트가 입출력을 주입한다(엔진 호출은 동기, REPL 입력 읽기만 비동기).

---

## G. Storage, Index, Transaction & Recovery Protocol

### G.1 Pager 상태

| 상태 | 내용 |
|---|---|
| `frames` | `Map<PageId, { data: Uint8Array(4096), pins: number, dirty: boolean }>` + LRU 순서(접근 시 맨 뒤로) |
| Page 0 | 항상 상주: 오픈 후 close까지 프레임이 **절대 제거되지 않는다**(축출·롤백 모두. 롤백은 G.5의 이미지 복원). pin 합계에 포함 안 함 |
| `txn` | `active`, `dirty: Set<PageId>`, `headerBefore: Uint8Array \| null`(이 트랜잭션에서 Page 0을 처음 `markDirty`하기 직전의 이미지 = 마지막 커밋 이미지) |
| `stmt` | `active`, `savepoint: Map<PageId, Uint8Array \| null>` |
| `wal` | `index: Map<PageId, frameNo>`, `frames: number`, `lastChecksum`, `salt1`, `salt2`, `checkpointSeq`, `dbId` |
| `checkpointDue` | boolean |
| `state` | `open` / `failed` / `closed` |

### G.2 읽기 (`pin(id)`)

1. `state ≠ open` → `DB_FAILED` / `DB_CLOSED`. `id ≥ pageCount` → `CorruptionError PAGE_OUT_OF_RANGE`.
2. 프레임이 있으면 pins+1, LRU 갱신, `cache.hits++`, 반환.
3. `cache.misses++`. 빈 프레임 확보: 프레임 수 < cachePages면 새로 만듦. 아니면 LRU 앞에서부터 `dirty = false ∧ pins = 0 ∧ id ≠ 0`인 첫 프레임을 축출(`evictions++`, 쓰기 없음). 없으면 `LimitError TXN_TOO_LARGE`(DC-16 덕분에 정상 경로에서는 발생하지 않음).
4. `wal.index`에 있으면 WAL 프레임 `48 + 4120·n + 24`에서 4096바이트 읽기(`walFrameReads++`), 아니면 데이터 파일 `id × 4096`에서 읽기(`dataPageReads++`). 읽은 바이트 < 4096 → `PAGE_OUT_OF_RANGE`.
5. 검증: CRC → pageId → pageType(D.1). 실패 → `CorruptionError` → FAILED.
6. 프레임 등록(clean), pins = 1, 반환.

`unpin(ref)`: pins−1, 0 미만 → `InternalError`.

### G.3 수정 (`markDirty`, `allocate`, `free`)

`markDirty(ref)` — **페이지 바이트를 바꾸기 전에** 호출:

1. `txn.active`가 아니거나 ref가 pin되어 있지 않으면 `InternalError`.
2. `txn.dirty`에 없고 `txn.dirty.size + 1 > cachePages − 32` → `LimitError TXN_TOO_LARGE`(아무것도 바꾸지 않은 상태에서 throw).
3. `stmt.active ∧ !stmt.savepoint.has(id)` → `savepoint.set(id, txn.dirty.has(id) ? copy(data) : null)`.
4. `id = 0 ∧ !txn.dirty.has(0)` → `txn.headerBefore = copy(data)`.
5. `txn.dirty.add(id)`, `frame.dirty = true`.

`allocate(type)`:

1. Page 0을 `markDirty`.
2. `freelistHead ≠ 0`이면: `id = freelistHead`, pin, pageType이 FREE가 아니면 `CorruptionError FREELIST_INVALID`, `markDirty`, `freelistHead = nextFree`, `freelistCount−1`.
   아니면: `id = pageCount`, `pageCount+1`, 0으로 채운 새 프레임을 만들어 pin하고 G.3의 2~5단계를 적용(savepoint 값은 `null`).
3. 페이지 전체 0으로, 공통 헤더(pageType, pageId) 기록. pin된 ref 반환.

`free(id)`: `1 ≤ id < pageCount` 아니면 `InternalError`. pin → `markDirty` → 전체 0 → pageType=FREE, `nextFree = freelistHead` → `freelistHead = id`, `freelistCount+1` → unpin.

### G.4 커밋 (`commitTxn`)

1. `txn.dirty`가 비어 있으면: 트랜잭션 종료만(쓰기·fsync 없음).
2. dirty 페이지를 pageId 오름차순으로 정렬. 각 페이지에 pageId 필드 확인 후 페이지 CRC 계산·기록.
3. 각 페이지 i에 대해 프레임 헤더(pageId, flags = 마지막이면 COMMIT, salt1, salt2, checksum 체인)를 만들고 **프레임 하나를 write 1회로** `48 + 4120·(wal.frames + i)`에 쓴다(`walFrameWrites++`).
4. **fsync(wal)** — **F4, 커밋 지점.**
5. 메모리 반영: `wal.index`에 각 페이지 → 프레임 번호, `wal.frames += n`, `lastChecksum` 갱신, dirty 프레임 → clean, `txn.dirty`/`savepoint` 비움, `txn.headerBefore = null`, `commits++`.
6. `walAutoCheckpointFrames > 0 ∧ wal.frames ≥ walAutoCheckpointFrames` → `checkpointDue = true`.
7. 3~4단계의 오류(I/O, CRC 계산 중 불변식 위반 등) → `StorageError IO_COMMIT_UNKNOWN`(결과 불명: 재오픈 후 적용됐을 수도 있음) + FAILED.

### G.5 롤백

- **문장 롤백** `rollbackStatement()`: `totalPins() ≠ 0` → `InternalError`. savepoint의 각 (id, img): `img ≠ null`이면 프레임 데이터에 복원(여전히 txn dirty). `img = null`이면 `id ≠ 0`은 프레임을 캐시에서 제거하고 `txn.dirty.delete(id)`, `id = 0`은 **프레임을 제거하지 않고** `txn.headerBefore`를 프레임 데이터에 복사, `frame.dirty = false`, `txn.dirty.delete(0)`, `txn.headerBefore = null`. savepoint 비움, `statementRollbacks++`. 엔진은 카탈로그 캐시 무효화.
- **트랜잭션 롤백** `rollbackTxn()`: `totalPins() ≠ 0` → `InternalError`. `txn.dirty`의 Page 0 외 프레임은 전부 제거. `txn.dirty`에 0이 있으면 Page 0 프레임은 남기고 `txn.headerBefore`를 데이터에 복사, `frame.dirty = false`. 집합 비움, `txn.headerBefore = null`, savepoint 비움, `rollbacks++`. 엔진은 카탈로그 캐시 무효화.
- Page 0 복원 결과는 제거 후 다시 읽은 것과 바이트 단위로 같다(`headerBefore`는 트랜잭션 시작 시 clean이던 마지막 커밋 이미지, I14). 따라서 "항상 상주"와 "롤백 = 마지막 커밋 상태"가 함께 성립한다.
- 둘 다 I/O가 없으므로 실패하지 않는다. 디스크에는 미커밋 데이터가 없다(no-steal).
- `releaseStatement()`: savepoint 비움(변경은 트랜잭션에 남음). `totalPins() ≠ 0` → `InternalError`.

### G.6 Checkpoint (`checkpoint()`)

전제: `state = open`, `txn.active = false`(아니면 `TransactionError TXN_ACTIVE`). `wal.frames = 0`이면 `checkpointDue = false`로 하고 종료.

1. `wal.index`의 pageId 오름차순으로: 이미지 = clean 캐시 프레임이 있으면 그것, 없으면 WAL 프레임에서 읽어 CRC 검증. 데이터 파일 `id × 4096`에 write 1회(`dataPageWrites++`).
2. **fsync(data)** — **F5.**
3. WAL 리셋(G.7의 `walReset`): truncate(0) → **fsync(wal) F2** → 새 헤더 write → **fsync(wal) F3**.
4. `wal.index` 비움, `wal.frames = 0`, `lastChecksum = 새 headerCrc`, `checkpointDue = false`, `checkpoints++`.
5. 1~3단계 오류 → `StorageError IO_ERROR` + FAILED.

### G.7 오픈·생성·복구 (`Pager.open`)

```text
open(path):
  lock = vfs.acquireLock(path)                                        # DB_LOCKED
  newData = !vfs.exists(path); newWal = !vfs.exists(path + "-wal")
  data = vfs.open(path); wal = vfs.open(path + "-wal")
  if newData or newWal: vfs.syncDir(dirname(path))                     # F1
  W = readWalHeader(wal)          # valid(hdr) | empty | throw WAL_HEADER_INVALID (헤더 무효 ∧ size > 48)
  C = W.valid ? scanWal(wal, W.hdr) : ∅   # 커밋된 pageId → 최신 프레임, recovery 통계
  if C ≠ ∅:
      if data에 유효한 헤더가 있고 그 dbId ≠ W.hdr.dbId: throw WAL_MISMATCH
      for id in sort(C.keys): data.write(readFrame(C[id]) /*페이지 CRC 검증*/, id*4096)
      data.sync()                                                       # F5
      H = readHeader(data)        # 무효면 해당 CorruptionError
      if H.dbId ≠ W.hdr.dbId: throw WAL_MISMATCH
  else if data.size() == 0:                                             # 새 DB
      dbId = entropy(8); walReset(dbId)                                 # F2, F3
      beginTxn(); allocate(HEADER) → Page 0 초기화(magic, version, pageSize, pageCount=1, dbId)
      opts.initialize(this)       # 엔진: Page 1 카탈로그 head 할당, setRootPointer(1)
      commitTxn()                                                       # F4
      checkpoint()                                                      # F5, F2, F3
      H = readHeader(data)
  else:
      H = readHeader(data)        # NOT_A_DATABASE / UNSUPPORTED_FORMAT_VERSION / PAGE_CHECKSUM_MISMATCH …
  if not (W.valid ∧ wal.size() == 48 ∧ W.hdr.dbId == H.dbId): walReset(H.dbId)   # F2, F3
  if data.size() < H.pageCount * 4096: throw FILE_TRUNCATED
  pageCount 등 상태 적재, wal.index = ∅  → 오픈 완료 후 WAL은 항상 비어 있다
```

```text
scanWal(wal, hdr):
  prev = hdr.headerCrc; pending = []; committed = Map(); k = 0
  loop:
    off = 48 + 4120*k
    if wal.size() - off < 4120: break
    f = read(off, 4120)
    if f.salt1 ≠ hdr.salt1 or f.salt2 ≠ hdr.salt2 or f.flags & ~1 ≠ 0 or f.reserved ≠ 0: break
    if crc32(LE32(prev) ‖ f[0..16) ‖ f.page) ≠ f.checksum: break
    if pageCRC(f.page) invalid or f.page.pageId ≠ f.pageId: throw WAL_FRAME_INVALID
    pending.push((f.pageId, k)); prev = f.checksum; k++
    if f.flags & COMMIT: for (id, n) in pending: committed.set(id, n); pending = []; txnsApplied++
  discardedTailBytes = wal.size() - (48 + 4120*lastCommittedFrameEnd)
  return committed

walReset(dbId):
  wal.truncate(0); wal.sync()                                           # F2
  seq = (이전 헤더가 유효하면 seq+1, 아니면 1); salt1, salt2 = entropy
  wal.write(header(dbId, seq, salts), 0); wal.sync()                    # F3
```

- 복구는 **항상 checkpoint까지** 수행하므로 오픈 후 WAL 크기는 정확히 48이다. 그래서 한 세션 안의 WAL 프레임 위치는 정확히 한 번만 쓰인다(D4).
- 복구 중 오류(Corruption 포함)는 `open()`이 throw하며 핸들을 만들지 않는다(락은 해제).

### G.8 닫기 (`close`)

1. `closed`면 반환. 2. `open`이고 `txn.active`면 `rollbackTxn`. 3. `open`이면 `checkpoint()`(실패 시 오류를 throw하되 파일 닫기·락 해제는 `finally`로 수행). 4. 파일 close, 락 해제, `state = closed`.

### G.9 fsync 지점과 크래시 관찰표

| ID | 지점 | 위치 | 선행 조건(순서 제약) |
|---|---|---|---|
| F1 | 부모 디렉터리 fsync | 데이터/WAL 파일을 새로 만든 오픈 | 새 파일에 어떤 write도 하기 전 |
| F2 | fsync(wal) after truncate | `walReset` | (checkpoint·복구에서) F5 이후 |
| F3 | fsync(wal) after header write | `walReset` | F2 이후, 그 세대의 첫 프레임 write 이전 |
| F4 | fsync(wal) after frames | `commitTxn` | 그 트랜잭션의 모든 프레임 write 이후, **성공 반환 이전** |
| F5 | fsync(data) after page writes | `checkpoint`, 복구 | 모든 이미지 write 이후, F2 이전 |

- 코드의 각 fsync 호출 줄에 `// FSYNC-F1` … `// FSYNC-F5` 주석을 단다. `check-docs.mjs`가 각 태그의 존재와 DURABILITY.md 목록 일치를 검사한다. 태그 없는 `sync()` 호출은 `src/storage/` 밖에 존재할 수 없다.
- 커밋당 fsync 1회(F4). checkpoint당 3회(F5, F2, F3). 새 DB 생성: F1 + F2·F3 + F4 + F5·F2·F3.

크래시 관찰표("이 단계에서 크래시 → 재오픈 후 보이는 것"). S = 마지막으로 **성공 반환된** 커밋까지의 상태, S⁺ = 진행 중이던 트랜잭션까지 적용한 상태.

| 경로 | 단계 | 크래시 후 디스크 | 재오픈 결과 |
|---|---|---|---|
| 커밋 | 프레임 write 일부/전부, F4 전 | 미sync 프레임의 임의 부분집합·찢어진 프레임 | 체인이 끊기거나 COMMIT 프레임이 무효 → **S**. 모든 프레임이 우연히 살아남으면 → **S⁺** (허용) |
| 커밋 | F4 진행 중 | 위와 같음 | S 또는 S⁺ |
| 커밋 | F4 완료 후 반환 전 | 프레임 전부 durable | **S⁺** |
| checkpoint | 데이터 write 일부(찢어짐 포함) | 데이터 파일 일부 갱신, WAL 온전 | WAL 재적용 → **S** |
| checkpoint | F5 이후, truncate 전후, F2 전후 | 데이터 durable, WAL은 온전하거나 비었거나 | 온전하면 재적용(멱등) → S, 비었으면 → S |
| checkpoint | 헤더 write/F3 | WAL 크기 ≤ 48, 헤더 유효 또는 무효 | 빈 WAL → **S** |
| 복구 | 재적용 write/F5 중 | WAL 그대로 | 다음 오픈에서 다시 재적용 → **S** (멱등, D6) |
| 복구 | WAL 리셋 중 | checkpoint와 같음 | **S** |
| 생성 | F1 전 | 새 파일이 사라질 수 있음 | 새 DB 생성 |
| 생성 | bootstrap 프레임 write, F4 전 | 데이터 크기 0, WAL에 미커밋 프레임 | 새 DB 생성(새 dbId, WAL 리셋) |
| 생성 | F4 이후 checkpoint 중 | 데이터 0~8192바이트(찢어짐 가능), WAL에 bootstrap 커밋 | 재적용 → 빈 DB |

### G.10 불변식

구조 불변식(`integrityCheck`가 검사, 위반 시 이슈 코드):

| ID | 불변식 | 이슈 코드 |
|---|---|---|
| I1 | Page 0: magic·버전·pageSize·CRC 유효, `catalogRoot = 1`, `pageCount ≥ 2`, 데이터 파일 크기 ≥ pageCount×4096 (WAL이 비었으면 =) | `HEADER_INVALID`, `FILE_SIZE_MISMATCH` |
| I2 | 모든 페이지 `[0, pageCount)`: CRC 유효, 저장된 pageId = 위치, pageType 유효 | `PAGE_CORRUPT` |
| I3 | 페이지 소유권: `[1, pageCount)`의 모든 페이지가 정확히 하나에 속함 — 카탈로그 힙 체인, 테이블 힙 체인, 인덱스 트리, freelist | `PAGE_LEAKED`, `PAGE_MULTI_OWNED` |
| I4 | freelist: 길이 = `freelistCount`, 순환 없음, 전부 FREE | `FREELIST_INVALID` |
| I5 | 힙 체인: 순환 없음, 전부 HEAP, head의 `tailPage` = 마지막 페이지, head 외 `tailPage = 0`, 마지막 `nextPage = 0` | `HEAP_CHAIN_INVALID` |
| I6 | slotted 기하: `32 + 4·slotCount ≤ recordStart ≤ 4096`, 살아있는 레코드는 `[recordStart, 4096)` 안에서 서로 겹치지 않음, `fragmentedBytes` 공식 성립, 마지막 slot은 살아 있음, tombstone은 (0,0) | `SLOTTED_PAGE_INVALID` |
| I7 | 레코드가 스키마로 디코딩됨, NOT NULL 준수, 정수 안전 범위, UTF-8 유효 | `RECORD_INVALID` |
| I8 | B+tree 모양: 모든 리프 깊이 동일, 내부 노드 `cellCount ≥ 1`, 가장 왼쪽 리프부터 `rightPtr` 체인이 모든 리프를 키 순서로 정확히 한 번 방문하고 0으로 끝남 | `BTREE_SHAPE_INVALID` |
| I9 | B+tree 순서: 노드 안 항목 순증가(비교기 DC-28), separator가 자식 범위를 제한, 유일 인덱스에 같은 키 없음, keyLen ≤ 512 | `BTREE_ORDER_INVALID` |
| I10 | B+tree 셀 기하(I6과 같은 방식, 포인터 2바이트) | `BTREE_PAGE_INVALID` |
| I11 | 인덱스 ↔ 힙: 인덱스 항목 다중집합 = { (encodeKey(row[col]), rid) : row[col] ≠ NULL } | `INDEX_HEAP_MISMATCH` |
| I12 | 카탈로그: D.7 적재 검증 규칙 전부 | `CATALOG_INVALID` |

런타임 불변식(코드 assertion, 위반 → `InternalError` + FAILED):

| ID | 불변식 |
|---|---|
| I13 | 문장 종료(성공·실패 모두) 시 `totalPins() = 0` |
| I14 | 트랜잭션 밖에서 dirty 프레임 0, savepoint 비어 있음, `txn.headerBefore = null`. 오픈 상태에서 Page 0 프레임은 항상 존재 |
| I15 | `wal.index`의 모든 프레임 번호 < `wal.frames`, pageId < pageCount |
| I16 | 데이터 파일 write는 `checkpoint`/복구 함수 안에서만 |

내구성 불변식(DURABILITY.md, 장애 주입으로 검증):

| ID | 불변식 |
|---|---|
| D1 | 커밋은 그 COMMIT 프레임을 포함한 F4가 끝난 뒤에만 성공을 반환한다 |
| D2 | 데이터 파일에 쓰는 이미지는 모두 이미 fsync된 WAL에 있는 커밋 이미지다(미커밋 데이터는 디스크에 가지 않음) |
| D3 | WAL truncate는 그 WAL의 모든 커밋 이미지가 데이터 파일에 쓰이고 F5가 끝난 뒤에만 |
| D4 | 한 WAL 세대 안에서 프레임 위치는 append-only, 한 번만 쓰인다 |
| D5 | 복구는 끊기지 않은 체인에서 마지막 유효 COMMIT 프레임까지만 적용한다 |
| D6 | 복구는 멱등이다: 전체 페이지 이미지만 쓰고, F5 전에는 WAL을 바꾸지 않는다 |
| D7 | 새로 만든 파일은 첫 write 전에 디렉터리 fsync(F1, 지원 플랫폼) |

### G.11 실패 상태 정책

| 사건 | 분류 | 결과 |
|---|---|---|
| 읽기 I/O 오류 | `StorageError IO_ERROR` | 문장 롤백, 핸들 사용 가능 |
| 커밋 중 write/fsync 오류 | `StorageError IO_COMMIT_UNKNOWN` | FAILED. 재오픈하면 S 또는 S⁺ |
| checkpoint/WAL 리셋 중 오류 | `StorageError IO_ERROR` | FAILED. 재오픈하면 S |
| 체크섬·포맷 불일치 | `CorruptionError *` | FAILED |
| 불변식 위반, 비-MiniDb 예외 | `InternalError INVARIANT_VIOLATION` | FAILED |
| FAILED 이후 호출 | `StorageError DB_FAILED`(`cause` = 최초 오류) | `close()`만 허용(쓰기 없이 닫음) |

FAILED에서 재시도·자동 재오픈을 하지 않는다. 사용자는 `close()` 후 `Database.open()`으로 복구를 수행한다.

### G.12 Heap 절차

`HeapPage.insert(bytes)`:
1. `need = len + (tombstone slot 존재 ? 0 : 4)`. 2. `contiguousFree ≥ need`면 레코드를 `recordStart − len`에 쓰고 `recordStart −= len`. 3. 아니고 `totalFree ≥ need`면 compaction 후 2. 4. 아니면 `no-space`(페이지 불변). 5. 가장 낮은 tombstone slot을 쓰거나 새 slot을 끝에 추가(`slotCount+1`).

`HeapPage.update(slot, bytes)` (**no-space면 페이지 바이트 불변**):
1. `newLen ≤ oldLen`: 같은 오프셋에 덮어쓰기, `length = newLen`, `fragmented += oldLen − newLen`.
2. `contiguousFree ≥ newLen`: `recordStart − newLen`에 쓰고 slot 갱신, `fragmented += oldLen`.
3. `totalFree + oldLen ≥ newLen`: slot을 임시로 비우고(`fragmented += oldLen`) compaction 후 2.
4. 그 외 `no-space`.

`HeapPage.delete(slot)`: `fragmented += length`, slot = (0,0), 꼬리 tombstone을 `slotCount`에서 잘라냄.

`compaction`: 살아 있는 레코드를 slot 번호 순으로 페이지 끝부터 아래로 다시 배치(임시 버퍼 사용), offset 갱신, `recordStart` 재계산, `fragmented = 0`. slot 번호와 tombstone은 그대로(RID 보존).

`HeapFile.insert(values)`: 인코딩(`ROW_TOO_LARGE`) → head의 `tailPage`에 삽입 → no-space면 새 HEAP 페이지 할당, 기존 tail의 `nextPage`·head의 `tailPage`를 새 페이지로(둘 다 `markDirty`) → 새 페이지에 삽입(반드시 성공).

`HeapFile.update(rid, values)`: 인코딩 → `HeapPage.update` 성공이면 같은 RID. no-space면 `HeapPage.delete` 후 `HeapFile.insert` → **다른 페이지의 새 RID**(같은 페이지에 들어갈 수 없음이 3단계에서 이미 판명).

`HeapFile.scan()`: (pageId, slot) 커서. `next()`마다 페이지를 pin → 다음 살아 있는 slot의 행 디코딩·복사 → unpin.

`HeapFile.destroy()`: 체인의 모든 페이지 `free`.

### G.13 B+tree 절차

비교: `cmp(a, b) = compareBytes(a.key, b.key)`, 비유일이면 0일 때 `(a.rid.pageId, a.rid.slot)` 사전식 비교. 유일 인덱스 탐색 키는 rid를 무시.

**탐색** `descend(target)`: 루트에서 시작. 내부 노드: `cmp(target, sep_i) < 0`인 첫 셀 i의 `leftChild`, 없으면 `rightPtr`. 지나온 (pageId, 선택한 자식 위치)를 path에 기록(pin은 노드마다 잡았다 놓음). 리프에서 이진 탐색으로 삽입 위치/첫 ≥ 위치.

**삽입** `insert(e)`:
1. `descend(e)`로 리프 L과 path.
2. 유일 인덱스에 같은 키가 있으면 `InternalError`(호출자가 먼저 `findUnique`로 검사해야 함).
3. L에 셀이 들어가면(필요 시 compaction) 정렬 위치에 삽입, 끝.
4. 아니면 **분할**: L의 모든 항목 + e를 정렬한 배열 `A`(길이 n). `size(x) = 셀 크기 + 2`. `m` = 누적 크기 ≥ 전체/2가 되는 가장 작은 인덱스, `1 ≤ m ≤ n−1`로 고정. 새 리프 R 할당. L ← `A[0..m)`, R ← `A[m..n)`, `R.rightPtr = L.rightPtr`, `L.rightPtr = R`. separator s = `A[m]`(key, rid 복사). 부모에 (L, s, R) 삽입.
5. **부모 삽입**(부모 P, 왼쪽 L, separator s, 새 오른쪽 R): P에서 L을 가리키던 곳이 셀 i의 `leftChild`면 셀 (L, s)를 셀 i 앞에 넣고 셀 i의 `leftChild = R`. L이 `P.rightPtr`였으면 셀 (L, s)를 끝에 넣고 `P.rightPtr = R`.
6. P가 넘치면 **내부 분할**: 셀 배열 `C`(길이 n, 새 셀 포함). `m`을 같은 방식으로 고르되 `1 ≤ m ≤ n−2`. 새 내부 노드 R. L ← `C[0..m)`, `L.rightPtr = C[m].leftChild`; R ← `C[m+1..n)`, `R.rightPtr = 원래 P.rightPtr`; 위로 올릴 separator = `C[m]`의 (key, rid). 재귀적으로 부모에 삽입.
7. **루트 분할**(루트 ID T 고정, DC-29): 넘친 노드가 루트이면 새 페이지 L, R을 할당해 4(리프) 또는 6(내부)의 분배를 L, R에 하고(리프면 `L.rightPtr = R`, `R.rightPtr = 0`), T를 BTREE_INTERNAL로 재초기화해 셀 1개 (L, s), `rightPtr = R`.

**삭제** `delete(e)`: `descend(e)` → 리프에서 정확히 같은 항목(유일: 같은 키 + 같은 rid 확인)을 찾아 셀 제거(`fragmented += 셀 크기`). 없으면 `InternalError`. 병합·재분배·separator 변경 없음(DC-30).

**범위 스캔** `scan(lo, hi)`: lo가 있으면 (lo.key, rid = (0,0))로 descend해 첫 ≥ 위치, 없으면 가장 왼쪽 리프의 0번. `next()`: 현재 리프의 셀이 끝났으면 `rightPtr`로 이동(빈 리프는 건너뜀), 0이면 끝. lo가 배타면 key = lo.key인 항목 건너뜀. hi를 넘으면(배타면 같음 포함) 끝. 커서는 (leafId, index)만 보관하고 pin을 유지하지 않는다. 스캔 중 트리 변경 금지(DML은 대상을 먼저 수집).

**`findUnique(key)`**: descend 후 리프에서 같은 키 → rid, 없으면 null.

**`destroy()`**: 전 노드 후위 순회로 `free`.

### G.14 DML·DDL 실행 절차

**INSERT** — VALUES 행마다 순서대로:
1. 값 식 평가(오버플로 → `INTEGER_OVERFLOW`). 대상 아닌 컬럼은 NULL.
2. 컬럼 순서로 NOT NULL 검사 → `ConstraintError NOT_NULL_VIOLATION`.
3. 행 인코딩 → `ROW_TOO_LARGE`.
4. 인덱스마다(PK 인덱스 먼저, 그다음 이름순) 값이 NULL이 아니면 `encodeKey`(`KEY_TOO_LARGE`), 유일이면 `findUnique` ≠ null → `ConstraintError UNIQUE_VIOLATION`.
5. `heap.insert` → rid. 6. 각 인덱스에 (key, rid) 삽입(NULL 제외).

**UPDATE**:
1. 플랜으로 대상 `(rid, old)` 전부 수집.
2. 대상 순서대로 새 행 계산(SET 식은 old 기준), NOT NULL 검사, 인코딩(`ROW_TOO_LARGE`), SET 대상 컬럼의 인덱스 키 인코딩(`KEY_TOO_LARGE`).
3. SET 대상 컬럼의 각 유일 인덱스: (a) 대상들의 새 키(NULL 제외)끼리 중복 → `UNIQUE_VIOLATION`; (b) 각 새 키 k에 대해 `findUnique(k) = r ≠ null ∧ r ∉ 대상 RID 집합` → `UNIQUE_VIOLATION`.
4. 대상마다 `newRid = heap.update(rid, new)`, `moved = (newRid ≠ rid)`.
5. 인덱스마다 영향 대상 = { 컬럼 ∈ SET ∨ moved }. 먼저 영향 대상 전부의 옛 항목 (oldKey, oldRid) 삭제, 그다음 새 항목 (newKey, newRid) 삽입(NULL 제외). 5에서 유일성 충돌이 나면 `InternalError`.

**DELETE**: 대상 수집 → 대상마다 모든 인덱스에서 (key, rid) 삭제(NULL 제외) → `heap.delete(rid)`.

**CREATE TABLE**: `HeapFile.create`(head 페이지, `tailPage = 자기`) → 카탈로그에 table·column 행 → PK가 있으면 `BTree.create` + `mdb_pk_<t>` index 행.
**CREATE [UNIQUE] INDEX**: `BTree.create` → 힙 전체 스캔하며 NULL이 아닌 값마다 키 인코딩(`KEY_TOO_LARGE`), 유일이면 `findUnique` 검사(`UNIQUE_VIOLATION`), 삽입 → index 행 기록.
**DROP INDEX**: `btree.destroy()` → index 행 삭제. **DROP TABLE**: 각 인덱스 destroy → `heap.destroy()` → 해당 테이블의 모든 카탈로그 행 삭제.

- 카탈로그 행은 갱신하지 않고 삽입·삭제만 하므로 카탈로그 행 RID는 안정적이며 캐시에 보관한다.
- P10~P12 동안(인덱스 전) PK 유일성은 같은 의미를 힙 스캔으로 구현한다(4단계, 3단계). P13에서 인덱스로 교체하며 의미는 같다.

### G.15 잠금 절차 (`acquireLock`)

1. 정규화된 절대 경로가 모듈 레지스트리에 있으면 `DB_LOCKED`.
2. `<db>-lock`을 `wx`로 생성 → 성공 시 `${process.pid}\n` 쓰고 닫기(fsync 없음) → 레지스트리 등록.
3. `EEXIST`: 내용 읽기 → `^\d+\n?$`가 아니면 `DB_LOCKED`. pid = 현재 PID → `DB_LOCKED`. `process.kill(pid, 0)`이 성공 또는 `EPERM` → `DB_LOCKED`. `ESRCH` → 락 파일 삭제 후 2를 **1회만** 재시도, 또 실패하면 `DB_LOCKED`.
4. 해제: 레지스트리 제거, 락 파일 삭제(오류 무시).
5. `MemoryVfs`는 같은 의미를 메모리 집합으로 구현(PID 검사 없음).

---

## H. Error Handling

### H.1 오류 계층

```text
Error
└── MiniDbError (code, position?, sourceLine?, statementIndex?, cause?)
    ├── SqlSyntaxError     — 렉서·파서
    ├── SemanticError      — 분석기(이름·타입·DDL 규칙)
    ├── ConstraintError    — NOT NULL, UNIQUE/PK
    ├── TransactionError   — 트랜잭션 상태 오류
    ├── LimitError         — 크기·범위 한도
    ├── StorageError       — I/O, 잠금, FAILED
    ├── CorruptionError    — 체크섬·포맷·구조 손상
    ├── InternalError      — 불변식 위반(버그)
    └── UsageError         — API 오용
```

- 모든 클래스는 `src/errors/errors.ts`에 있고 `name` 속성이 클래스 이름과 같다.
- `SimulatedCrash`(FaultVfs)는 `MiniDbError`가 아니며 감싸지 않는다(테스트가 크래시를 감지해야 하므로).

### H.2 오류 코드 (전체 목록, 안정)

| 클래스 | 코드 | 발생 조건 | 위치 |
|---|---|---|---|
| SqlSyntaxError | `SYNTAX_UNEXPECTED_TOKEN` | 기대와 다른 토큰 | 그 토큰 |
| SqlSyntaxError | `SYNTAX_UNEXPECTED_EOF` | 입력이 문장 중간에 끝남 | 입력 끝 |
| SqlSyntaxError | `SYNTAX_UNTERMINATED_STRING` | 닫히지 않은 문자열 | 여는 `'` |
| SqlSyntaxError | `SYNTAX_INVALID_STRING` | lone surrogate | 여는 `'` |
| SqlSyntaxError | `SYNTAX_INVALID_CHARACTER` | 허용되지 않은 문자 | 그 문자 |
| SqlSyntaxError | `SYNTAX_INVALID_NUMBER` | `123abc` | 숫자 시작 |
| SqlSyntaxError | `SYNTAX_EMPTY_STATEMENT` | `execute`에 문장 없음 | 입력 끝 |
| SqlSyntaxError | `SYNTAX_MULTIPLE_STATEMENTS` | `execute`에 2문장 이상 | 두 번째 문장 시작 |
| SemanticError | `TABLE_NOT_FOUND` | | 이름 토큰 |
| SemanticError | `INDEX_NOT_FOUND` | | 이름 토큰 |
| SemanticError | `COLUMN_NOT_FOUND` | | 이름 토큰 |
| SemanticError | `OBJECT_EXISTS` | 이름 공간 중복 | 이름 토큰 |
| SemanticError | `DUPLICATE_COLUMN` | CREATE/INSERT 목록/SET 중복 | 두 번째 등장 |
| SemanticError | `DUPLICATE_CONSTRAINT` | 같은 제약 반복 | 두 번째 등장 |
| SemanticError | `MULTIPLE_PRIMARY_KEYS` | | 두 번째 PRIMARY |
| SemanticError | `TYPE_MISMATCH` | F.4 위반 | 연산자 또는 값 식 |
| SemanticError | `COLUMN_COUNT_MISMATCH` | VALUES 행 길이 | 그 행의 `(` |
| SemanticError | `NOT_CONSTANT` | VALUES 안 컬럼 참조 | 그 식별자 |
| SemanticError | `RESERVED_NAME` | `mdb_` 접두사 | 이름 토큰 |
| SemanticError | `CANNOT_DROP_PK_INDEX` | | 이름 토큰 |
| ConstraintError | `NOT_NULL_VIOLATION` | | INSERT: 그 행의 `(`, UPDATE: 문장 시작 |
| ConstraintError | `UNIQUE_VIOLATION` | PK 포함 | INSERT: 그 행의 `(`, UPDATE/CREATE INDEX: 문장 시작 |
| TransactionError | `TXN_ALREADY_ACTIVE` | 중첩 BEGIN | `BEGIN` |
| TransactionError | `TXN_NOT_ACTIVE` | 트랜잭션 없이 COMMIT/ROLLBACK | 그 키워드 |
| TransactionError | `TXN_ACTIVE` | 트랜잭션 중 `checkpoint()`/`integrityCheck()` | 없음 |
| LimitError | `ROW_TOO_LARGE` | > 4060 | INSERT: 행 `(`, UPDATE: 문장 시작 |
| LimitError | `KEY_TOO_LARGE` | > 512 | 위와 같음 |
| LimitError | `TEXT_TOO_LARGE` | > 4000 | 문자열 리터럴 |
| LimitError | `TOO_MANY_COLUMNS` | > 64 | 65번째 컬럼 |
| LimitError | `IDENTIFIER_TOO_LONG` | > 64 | 식별자 |
| LimitError | `INTEGER_OUT_OF_RANGE` | 리터럴 범위 밖 | 리터럴 |
| LimitError | `INTEGER_OVERFLOW` | 연산 결과 범위 밖 | 그 연산자 노드 |
| LimitError | `TXN_TOO_LARGE` | DC-16 | 문장 시작 |
| StorageError | `IO_ERROR` | 읽기·checkpoint·생성 I/O 오류 | 없음 |
| StorageError | `IO_COMMIT_UNKNOWN` | 커밋 중 I/O 오류 | 없음 |
| StorageError | `DB_LOCKED` | G.15 | 없음 |
| StorageError | `DB_FAILED` | FAILED 이후 호출 | 없음 |
| CorruptionError | `NOT_A_DATABASE` | magic 불일치, 크기 < 4096 | 없음 |
| CorruptionError | `UNSUPPORTED_FORMAT_VERSION` | 버전·pageSize | 없음 |
| CorruptionError | `FILE_TRUNCATED` | 크기 < pageCount×4096 | 없음 |
| CorruptionError | `PAGE_CHECKSUM_MISMATCH` | | 없음(메시지에 pageId) |
| CorruptionError | `PAGE_ID_MISMATCH` | | 없음 |
| CorruptionError | `PAGE_TYPE_INVALID` | 알 수 없는 pageType | 없음 |
| CorruptionError | `PAGE_TYPE_MISMATCH` | 포인터가 예상과 다른 타입의 페이지를 가리킴 | 없음 |
| CorruptionError | `PAGE_OUT_OF_RANGE` | pageId ≥ pageCount 또는 파일 밖 | 없음 |
| CorruptionError | `FREELIST_INVALID` | | 없음 |
| CorruptionError | `RECORD_MALFORMED` | D.4 디코딩 실패, slot 범위 오류 | 없음 |
| CorruptionError | `BTREE_MALFORMED` | 노드 구조 위반(셀 범위 등) | 없음 |
| CorruptionError | `INDEX_HEAP_MISMATCH` | 인덱스가 없는 행을 가리킴 | 없음 |
| CorruptionError | `CATALOG_INVALID` | D.7 검증 실패 | 없음 |
| CorruptionError | `WAL_HEADER_INVALID` | DC-22 | 없음 |
| CorruptionError | `WAL_FRAME_INVALID` | 체인 유효·페이지 CRC 무효 | 없음 |
| CorruptionError | `WAL_MISMATCH` | dbId 불일치 | 없음 |
| InternalError | `INVARIANT_VIOLATION` | 불변식 위반, 비-MiniDb 예외 감싸기 | 없음 |
| UsageError | `DB_CLOSED` | 닫힌 핸들 사용 | 없음 |
| UsageError | `INVALID_OPTION` | 옵션 범위 밖 | 없음 |

`src/errors/codes.ts`는 이 표와 같은 집합을 `as const`로 정의하고, `check-docs.mjs`가 SPEC.md의 표와 대조한다.

### H.3 메시지 형식

- `err.message`: 사람이 읽는 한 문장(위치 없음). 예: `expected ')' but found ','`.
- `err.format()`:

```text
<ClassName> <CODE> at <line>:<column>: <message>
  <line> | <source line>
       | <공백><^>
```

  - 위치가 없으면 첫 줄은 `<ClassName> <CODE>: <message>`이고 나머지 두 줄은 없다.
  - 소스 줄: 공백 2칸 + `<line>` + ` | ` + 소스 줄. 캐럿 줄: 공백 2칸 + `<line>` 자릿수만큼 공백 + ` | ` + (column−1개 코드 포인트를 탭은 탭, 나머지는 공백으로) + `^`.
  - `executeScript`/CLI에서 `statementIndex`가 있으면 첫 줄 끝에 ` (statement <n>)`(1부터).
- 예:

```text
SqlSyntaxError SYNTAX_UNEXPECTED_TOKEN at 1:25: expected ')' but found ','
  1 | SELECT * FROM t WHERE (a, b)
    |                         ^
ConstraintError UNIQUE_VIOLATION at 2:8: duplicate key in index mdb_pk_users (column id)
  2 |        (1, 'bob')
    |        ^
LimitError INTEGER_OVERFLOW at 1:20: integer result out of range
  1 | UPDATE t SET n = n * 9007199254740991
    |                    ^
StorageError DB_FAILED: database is in failed state; close and reopen (cause: IO_COMMIT_UNKNOWN)
```

### H.4 위치 규칙

1. 렉서·파서·분석기 오류는 H.2의 "위치" 토큰 시작 위치.
2. 런타임 오류는 바운드 노드가 보존한 소스 위치(파서가 모든 AST 노드에 `pos`를 넣고 분석기가 그대로 옮긴다).
3. `position`과 `sourceLine`은 항상 같이 있거나 같이 없다. `sourceLine`은 해당 줄 전체(줄바꿈 제외).
4. `executeScript`의 위치는 스크립트 전체 텍스트 기준(문장별 재계산 없음).

### H.5 오류 후 상태 보장

| 오류 | DB 상태 | 트랜잭션 | 핸들 |
|---|---|---|---|
| SqlSyntaxError, SemanticError | 변경 없음 | 그대로 | 사용 가능 |
| ConstraintError, LimitError(실행 중), TransactionError | 그 문장 이전 상태(문장 롤백) | 자동 커밋: 롤백 / 명시적: 유지(이전 문장 변경 유지) | 사용 가능 |
| StorageError IO_ERROR(읽기) | 문장 롤백 | 위와 같음 | 사용 가능 |
| StorageError IO_COMMIT_UNKNOWN / IO_ERROR(쓰기) | 디스크는 S 또는 S⁺ | 종료 | FAILED |
| CorruptionError, InternalError | 디스크는 마지막 durable 커밋(손상 부분 제외) | 종료 | FAILED |
| UsageError | 변경 없음 | 그대로 | 그대로 |

---

## I. Risk Register

| ID | 위험 | 증상 | 원인 | 방지 설계 | 대응 테스트 |
|---|---|---|---|---|---|
| R01 | 커밋 fsync 누락·순서 오류 | 성공 반환된 커밋이 크래시 후 사라짐 | F4 전 반환, 프레임 쓰기 경로 중복 | D1, 커밋 경로 단일 함수, `FSYNC-F4` 태그 | T-CRASH-001, T-CRASH-004, T-STAT-001, T-PGR-006 |
| R02 | checkpoint가 데이터 fsync 전에 WAL 리셋 | checkpoint 중 크래시 후 커밋 소실·찢어진 페이지 | F5↔F2 순서 위반 | D3, G.6 순서 고정 | T-CRASH-003, T-CRASH-004, T-CRASH-P01 |
| R03 | 데이터 파일 torn write | 체크섬 불일치·쓰레기 페이지 | 페이지 쓰기 원자성 가정 | 데이터 파일엔 WAL에 durable한 이미지만, 복구가 재기록, CRC | T-CRASH-P01, T-CRASH-003, T-PAGE-002 |
| R04 | WAL 꼬리 손상·미sync 부분집합 | 반쯤 적용된 트랜잭션 | 커밋 표시·체인 검사 누락 | 체크섬 체인, COMMIT 프레임, D5 중단 규칙 | T-WAL-004, T-WAL-006, T-CRASH-001 |
| R05 | 체크섬 범위 오류 | 정상 페이지를 손상으로 판정하거나 손상 미탐지 | CRC 필드 포함/제외 실수, 범위 일부만 | 단일 `pageCrc()`, 전 비트 플립 전수 검사 | T-CRC-001, T-PAGE-002, T-WAL-001, T-CORR-001 |
| R06 | 복구 비멱등 | 복구 중 재크래시 후 상태가 달라짐 | 복구가 WAL을 먼저 수정 | D6, F5 후에만 리셋 | T-CRASH-002, T-CRASH-P02 |
| R07 | checkpoint 도중 크래시 | 데이터 손상 | 부분 쓰기 후 WAL 의존 상실 | G.9 관찰표, WAL 보존 | T-CRASH-003 |
| R08 | WAL 헤더 손상과 리셋 중 크래시 구분 실패 | 정상 DB를 손상으로 거부하거나 손상 WAL을 무시 | truncate·헤더 쓰기 순서 | truncate→F2→header→F3, 크기 규칙(DC-22) | T-WAL-008, T-CORR-002, T-CRASH-003 |
| R09 | 다른 DB의 WAL 적용 | 엉뚱한 페이지로 덮어씀 | WAL과 DB 짝 검증 없음 | dbId(DC-64) | T-WAL-009, T-CORR-004 |
| R10 | 생성 도중 크래시로 열 수 없는 DB | 재오픈 시 `NOT_A_DATABASE` | 생성이 원자적이지 않음 | bootstrap 트랜잭션(DC-63) | T-CRASH-P03 |
| R11 | B+tree 분할 불변식 위반 | 키 누락·순서 오류·리프 연결 끊김 | 루트 분할, separator 선택, rightPtr 갱신 실수 | G.13 고정 절차, 검사기 I8~I10 | T-BT-002, T-BT-003, T-BT-007 |
| R12 | 비유일 인덱스 순서 오류 | 범위 스캔 누락 | 키‖RID 이어붙이기의 접두사 문제 | 튜플 비교기(DC-28) | T-KEY-001, T-BT-005 |
| R13 | lazy 삭제 후 빈 리프 | 스캔이 일찍 끝나거나 실패 | 빈 리프에서 커서 처리 누락 | 빈 리프 건너뛰기 규칙 | T-BT-006 |
| R14 | RID 이동 후 인덱스 불일치 | 인덱스가 없는/다른 행을 가리킴 | 이동 시 일부 인덱스만 갱신 | DC-27, G.14 UPDATE 5단계, I11 | T-HEAP-002, T-IDX-002, T-MODEL-002, T-INTEG-002 |
| R15 | Halloween 문제 | 한 행이 두 번 갱신 | 스캔 중 이동한 행을 다시 읽음 | 대상 materialize(DC-62) | T-EXEC-004 |
| R16 | 페이지 누수·이중 사용 | 파일 팽창, 두 구조가 한 페이지 공유 | free/allocate 누락, 롤백 후 freelist 불일치 | 헤더도 페이지(롤백 자동 복원), 소유권 검사 I3·I4 | T-PGR-005, T-CAT-004, T-BT-008, T-HEAP-003, T-INTEG-002 |
| R17 | slotted page 공간 계산 off-by-one | 레코드 겹침·덮어쓰기 | 경계 계산 오류 | D.3 공식, 매 연산 후 기하 검사(테스트) | T-HP-002, T-HP-004 |
| R18 | compaction 후 slot 무효화 | RID가 다른 행을 가리킴 | compaction이 slot 번호를 바꿈 | slot 번호 보존 규칙 | T-HP-003 |
| R19 | 행·키 크기 경계 | 상한에서 실패하거나 초과가 통과 | 오버헤드 계산 누락 | 정확한 상수(DC-10, DC-11) | T-ROW-002, T-KEY-002, T-IDX-005, T-EXEC-013 |
| R20 | UTF-8 바이트와 문자 수 혼동 | 길이 한도·정렬 오류, 문자 손실 | `string.length` 사용, JS 비교, lone surrogate | 바이트 기준 함수만 사용, 렉서 거부 | T-LEX-005, T-EVAL-004, T-ROW-001, T-KEY-001 |
| R21 | NULL 3값 논리·정렬 경계 | 잘못된 필터·정렬 | 2값 논리 사고 | F.5 진리표, DC-34 | T-EVAL-001, T-EVAL-002, T-EXEC-005, T-IDX-004, T-MODEL-001 |
| R22 | 정수 안전 범위 이탈 | 조용한 정밀도 손실 | float 연산 결과 미검사 | 연산마다 `isSafeInteger`, 디스크 값 검사 | T-LEX-004, T-EVAL-003, T-ROW-003 |
| R23 | 문장 중간 실패 시 부분 적용 | 다중 행 INSERT 일부만 남음 | savepoint 누락 | DC-23, 모든 문장은 savepoint 안에서 | T-PGR-008, T-EXEC-002, T-EXEC-003, T-IDX-001, T-MODEL-003 |
| R24 | 롤백 후 파생 캐시 불일치 | DROP 롤백 후 테이블이 안 보이는 등 | 카탈로그 캐시 미무효화 | DC-25 | T-CAT-005, T-EXEC-009, T-MODEL-003 |
| R25 | 캐시 축출·pin·no-steal 한도 오류 | 변경 유실, 미커밋 데이터 디스크 유출 | pin 없이 참조 보유, dirty 축출 | clean·unpin만 축출, I13·I14, DC-16 | T-PGR-003, T-PGR-004, T-PGR-011, T-PGR-012 |
| R26 | 오류 위치 정보 손실 | 위치 없는 SQL 오류 | AST에 pos 미전달 | 모든 노드에 pos(H.4) | T-ERR-002, T-LEX-001, T-PAR-004 |
| R27 | 비-MiniDb 예외 누출, 불확실 상태로 계속 사용 | TypeError 노출, 손상 위 쓰기 | 감싸기·FAILED 누락 | DC-49, DC-51 | T-ERR-003, T-PAR-005, T-CORR-001, T-FAIL-001, T-FAIL-002, T-FAIL-003, T-FAIL-004 |
| R28 | 테스트 과결합·오라클이 구현 버그 공유 | 테스트는 통과, 실제 동작은 틀림 | 오라클이 src 재사용, 내부 구조 assertion | 참조 모델 import 제한, 관찰 가능한 동작만 비교, 오라클 자체 테스트 | T-ARCH-002, T-MODEL-004, T-DIFF-001 |
| R29 | 무작위 테스트 비결정성·느림 | 재현 불가, CI 시간 초과 | `Math.random`, 시간 의존, 순서 미정 결과 비교 | DC-66, seed 출력, 다중집합 비교, 시간 예산 | T-PRNG-001, T-ARCH-003, T-MODEL-005 |
| R30 | 장애 주입 하네스 버그 | 크래시 테스트가 거짓 통과 | 미sync 유실·찢어짐 모델 오류 | FaultVfs 자체 테스트 | T-VFS-003, T-VFS-004, T-VFS-005, T-VFS-006, T-VFS-007 |
| R31 | fsync 실패 후 계속 사용 | 성공처럼 보이는 손실 | 재시도 | FAILED(DC-49) | T-FAIL-001, T-FAIL-002 |
| R32 | 범위 확장·한도 중단 시 상태 손실 | 미완 기능, 재개 불가 | 문서 없는 작업 | N 규칙, 단계 게이트, 추적 스크립트 | T-TRACE-001 |
| R33 | 플랫폼 차이 | Windows에서만 실패, 줄바꿈 차이 | 디렉터리 fsync·잠금·CRLF | DC-52, DC-53, DC-69 | T-VFS-007, T-LOCK-001, T-LOCK-002, T-LOCK-003, T-LEX-001, T-GOLD-001, T-PGR-016 |
| R34 | 이중 오픈 동시 쓰기 | WAL 충돌·손상 | 잠금 없음 | DC-52 | T-LOCK-001, T-LOCK-002, T-LOCK-003, T-LOCK-004 |
| R35 | 의존 방향 위반 | storage가 SQL을 앎, 순환 | 편의 import | E.2 표 | T-ARCH-001 |
| R36 | 플래너 범위 계산 오류 | 인덱스 경로에서 행 누락 | 포함/배타 경계 결합 실수 | F.8 규칙, Filter 재검사 | T-BT-004, T-PLAN-001, T-DIFF-001 |
| R37 | 카탈로그 손상·불일치 | 오픈 실패 또는 잘못된 스키마 | 검증 부족 | D.7 적재 검증 | T-CAT-003, T-INTEG-002 |
| R38 | UPDATE 유일성의 순서 의존 | 같은 문장이 플랜에 따라 성공/실패 | 행 단위 즉시 검사 | DC-31 문장 수준 검사 | T-EXEC-003, T-MODEL-002 |

---

## J. Test Strategy

### J.1 계층별 계획

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

### J.2 테스트 ID 정의

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
| T-CRASH-001 | SQL 수준 crash matrix CW1~CW5 × 정책(J.5) | P14 |
| T-CRASH-002 | SQL 수준 복구 중 재크래시(CW6) | P14 |
| T-CRASH-003 | checkpoint 내부 6개 지점(데이터 write, F5, truncate, F2, 헤더 write, F3) 각각이 matrix에서 1회 이상 크래시됨을 단언 | P14 |
| T-CRASH-004 | opLog 패턴 검사: 커밋 = `write(wal)+ → sync(wal)`, checkpoint = `write(data)+ → sync(data) → truncate(wal) → sync(wal) → write(wal) → sync(wal)` | P5, P14 |
| T-CRASH-005 | 무작위 워크로드 + 무작위 크래시 지점·정책(long, seeds) | P14 |
| T-CORR-001 | checkpoint된 DB의 페이지 타입별로 비트 플립 → 오픈/전체 SELECT/integrityCheck 중 하나에서 Corruption(이슈 또는 오류), 다른 예외·다른 데이터 반환 없음 | P14 |
| T-CORR-002 | WAL 헤더 비트 플립(크기>48) → `WAL_HEADER_INVALID`, 프레임 비트 플립 → 커밋 접두 상태 + 무결성 통과 | P14 |
| T-CORR-003 | 무작위 바이트 파일·4096 미만·pageCount보다 짧은 파일 → `NOT_A_DATABASE`/`FILE_TRUNCATED` | P14 |
| T-CORR-004 | 다른 DB의 WAL(커밋 프레임 포함) → `WAL_MISMATCH` | P14 |
| T-BENCH-001 | 벤치마크 하네스 스모크(N 아주 작게): JSON 필수 필드 존재 | P16 |

### J.3 참조 모델 설계

- 위치: `tests/model/`. `src/` import 금지(`src/util/prng.ts`만 예외, T-ARCH-002).
- 상태: `Map<tableName, { columns: {name, type, notNull, pk}[]; rows: Value[][]; uniqueCols: Set<string>; indexes: Map<name, {column, unique}> }>`. 행 순서는 의미 없음.
- 생성기는 **테스트 소유 AST**(`GenStmt`)를 만든다. `render.ts`가 SQL 텍스트로 바꿔 DB에 보내고, `ref-model.ts`가 `GenStmt`를 직접 해석한다(SQL 파싱 없음).
- 평가기: 3값 논리를 JS로 직접 구현(`true | false | null`), 비교는 `Buffer.compare(Buffer.from(a,'utf8'), …)`, 오버플로 판정은 `Number.isSafeInteger`.
- 판정 결과: `{ ok: true, result } | { ok: false, codes: Set<ErrorCode> }`. 모델은 문장 실패 여부와 **가능한 오류 코드 집합**을 계산한다(여러 위반이 동시에 있으면 모두 포함).
- 트랜잭션: BEGIN 시 깊은 복사 스냅숏, ROLLBACK 시 복원. 문장 실패 시 문장 직전 스냅숏으로 복원.
- UPDATE 유일성: 최종 상태(비대상 ∪ 새 행)에서 각 유일 컬럼의 NULL 아닌 값 중복 여부(DC-31과 동치).
- 보장하는 것: 결과 행(다중집합 또는 전순서), 변경 행 수, 실패 여부와 코드 집합 포함 관계, 문장·트랜잭션 원자성, 깨끗한 재오픈 후 지속성, DDL 의미.
- 보장하지 못하는 것(별도 오라클 필요): 크래시 의미론(J.5), 물리 포맷(T-FMT-002·무결성 검사), 플랜 선택(T-PLAN-*), 오류 위치·메시지(T-ERR-*, T-PAR-004), ORDER BY 없는 결과 순서, 성능.

### J.4 무작위 생성기와 비교 규칙

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

### J.5 장애 주입 설계와 crash matrix

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
| CW6 | CW4·CW5의 WAL이 비어 있지 않은 크래시 이미지마다, 재오픈(복구) 연산 전 지점에서 다시 크래시 | SQL |

절차(워크로드 W, 정책 P, 지점 k):
1. 무결점 실행으로 W의 총 연산 수 N과 각 트랜잭션 경계를 기록. 참조 모델(페이지 수준은 `Map` 모델)로 상태 S₀…S_m 계산.
2. `FaultVfs(crashAtOp=k)`로 W 실행 → `SimulatedCrash`까지 성공 반환된 커밋 수 a 기록.
3. `crashImage(P)`로 새 `MemoryVfs`를 만들어 오픈(장애 없음).
4. 단언: (a) 오픈 성공, (b) `integrityCheck().ok`, (c) 덤프 ∈ {S_a, S_{a+1}}(진행 중 트랜잭션이 없으면 S_a만), (d) close 후 다시 열어도 같은 덤프(복구 멱등).
5. k = 1…N 전부, P 전부(P-RANDOM은 s = 1, 2, 3).

| 스위트 | 내용 | 예상 실행 수 |
|---|---|---|
| `npm test` (crash-short) | CW2 × {P-DURABLE, P-TORN(512)} 전 지점, PW1 × P-DURABLE 전 지점 | ~300 |
| `npm run test:crash` | PW1, CW1~CW6 × 모든 정책 × 전 지점 | 수천~2만 (≤ 15분) |

### J.6 손상 테스트

- 대상 DB: CW4 종료 후 `close()`(WAL 빈 상태)한 이미지.
- 페이지 비트 플립: HEADER, 카탈로그 HEAP, 테이블 HEAP, BTREE_INTERNAL, BTREE_LEAF, FREE 각 타입에서 seed로 고른 페이지 3개 × 비트 5개.
- 기대: `Database.open` 또는 모든 테이블 `SELECT *` 또는 `integrityCheck()`에서 `CorruptionError`(또는 `PAGE_CORRUPT` 이슈). FREE 페이지 손상은 integrityCheck에서 검출. 어떤 경우에도 `MiniDbError`가 아닌 예외, 원본과 다른 행 반환이 없어야 한다.
- WAL: 커밋 3개가 든 WAL 이미지(close 없이 핸들 폐기)에서 헤더 비트 → `WAL_HEADER_INVALID`, 프레임 비트 → 상태 ∈ {S₀…S₃}이고 무결성 통과.
- 파일 수준: 무작위 바이트 10KB, 1000바이트 파일, pageCount보다 한 페이지 짧은 파일.

### J.7 seed 재현 규칙

- 환경 변수: `SEED`(단일 seed), `SEEDS`(개수, 기본: short 20 / long 200), `SEED_START`(기본 1), `STEPS`(기본: short 300 / long 1000).
- 실패 메시지 마지막 줄 형식:
  - `REPRO (bash): SEED=<s> STEPS=<n> npx vitest run --config vitest.long.config.ts tests/long/random.long.test.ts`
  - `REPRO (PowerShell): $env:SEED=<s>; $env:STEPS=<n>; npx vitest run --config vitest.long.config.ts tests/long/random.long.test.ts`
- 크래시 실패: `workload=<CWn> policy=<P> op=<k> seed=<s>`와 같은 형식의 재현 명령(`CRASH_CASE=CW4:P-RANDOM:137:2`).
- 무작위 테스트가 실패하면 그 seed를 `tests/integration/regressions.test.ts`의 고정 seed 목록에 추가한다(수정 후에도 유지).

### J.8 실행 시간 예산

| 명령 | 예산(개발 머신) | 초과 시 |
|---|---|---|
| `npm test` | ≤ 60초(목표 30초) | 짧은 스위트의 seed/지점 수를 줄이고 long으로 이동. 테스트 삭제 금지 |
| 단일 테스트 파일 | ≤ 10초(`testTimeout` 10000) | 분할 |
| `npm run test:random` | 기본 설정 ≤ 10분 | `SEEDS`로 조절 |
| `npm run test:crash` | ≤ 15분 | 정책별 분할 실행 옵션 `CRASH_POLICY` |

### J.9 스크립트와 설정

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

---

## K. Benchmark Strategy

### K.1 원칙

- P15(하드닝) 통과 후에만 수행. 기능 완료 조건이 아니다.
- 모든 데이터는 seed PRNG로 생성(`BENCH_SEED`, 기본 42). 실행마다 `bench/results/tmp/`에 새 DB 파일.
- 기본 스키마: `CREATE TABLE items (id INTEGER PRIMARY KEY, grp INTEGER NOT NULL, name TEXT NOT NULL, flag BOOLEAN)`, `name`은 길이 8~24의 ASCII, `grp`는 [0, 999].
- 대규모 단일 트랜잭션 시나리오는 `cachePages = 16384`로 연다(DC-16 한도). 그 외는 기본값.

### K.2 시나리오

| ID | 시나리오 | 크기·변수 | 보고 지표 |
|---|---|---|---|
| B1 | 대량 INSERT, 자동 커밋 | N = 2,000 | 시간/행, walSyncs, walFrameWrites |
| B2 | 대량 INSERT, 단일 트랜잭션 | N = 2,000, 100,000 | 시간/행, walSyncs, 페이지 수 |
| B3 | 점 조회 | 테이블 100,000행. PK 조회 1,000회 vs 인덱스 없는 `name` 조회 50회 | 조회당 시간, 조회당 페이지 읽기 |
| B4 | 범위 스캔 | `grp` 보조 인덱스, 선택도 0.1%/1%/10%, 기본 플랜 vs `forceSeqScan` | 시간, 페이지 읽기 |
| B5 | 전체 스캔 | 100,000행 `SELECT *` | 시간, 행/초 |
| B6 | UPDATE/DELETE | 10% 행 UPDATE(크기 유지 / TEXT를 늘려 이동 유발), 10% DELETE | 시간, 이동 비율(페이지 수 변화), WAL 프레임 수 |
| B7 | ORDER BY | 100,000행 `ORDER BY name` 전체 vs `LIMIT 10` | 시간 |
| B8 | 캐시 크기 스윕 | cachePages ∈ {64, 256, 1024, 4096, 16384}, 무작위 PK 조회 5,000회 | 적중률, 페이지 읽기, 시간 |
| B9 | WAL 크기별 복구 시간 | `walAutoCheckpointFrames = 0`, WAL 프레임 ≈ 0/100/1,000/10,000에서 핸들 폐기 후 `open` | open 시간, framesApplied |
| B10 | 삭제-재삽입 반복 | 10,000행에서 "50% 삭제 → 같은 수 삽입" 10회 | 매 회 pageCount, freePages |

### K.3 측정 방법

- 타이머 `process.hrtime.bigint()`. 각 시나리오: 워밍업 1회(버림) + 측정 5회. 쓰기 시나리오는 반복마다 새 DB.
- 통계: 중앙값, 최소, 최대, IQR(Q3−Q1)과 중앙값 대비 IQR 비율. IQR/중앙값 > 0.3이면 결과에 `unstable: true` 표시.
- I/O는 측정 구간 직전 `resetStats()`, 직후 `stats()` 차이.
- 환경 기록: `process.version`, `os.platform()`, `os.release()`, `os.cpus()[0].model`, CPU 수, `os.totalmem()`, DB 경로, `BENCH_DISK`(사용자가 적는 디스크 설명, 없으면 `"unknown"`), git 커밋 hash.
- 측정 중 다른 무거운 작업 금지를 BENCHMARKS.md에 명시. Windows의 fsync(FlushFileBuffers) 비용이 B1을 지배함을 해석에 적는다.

### K.4 보고 형식

`bench/results/<YYYYMMDD-HHmm>-<shortsha>.json`:

```json
{
  "env": { "node": "v24.16.0", "platform": "win32", "release": "…", "cpu": "…", "cpus": 8, "totalMemMiB": 32768, "disk": "…", "commit": "abc1234" },
  "seed": 42,
  "scenarios": [
    { "id": "B3", "variant": "pk-lookup", "params": { "rows": 100000, "ops": 1000 },
      "timeMs": { "median": 0, "min": 0, "max": 0, "iqr": 0 }, "unstable": false,
      "io": { "dataPageReads": 0, "walFrameReads": 0, "dataPageWrites": 0, "walFrameWrites": 0, "dataSyncs": 0, "walSyncs": 0, "cacheHitRate": 0 } }
  ]
}
```

BENCHMARKS.md: 환경 표 → 시나리오별 표(중앙값, IQR, 핵심 I/O) → 건전성 확인 결과 → 해석 → 최적화 기록(before/after).

### K.5 건전성 확인 (합격/불합격 아님, 어긋나면 조사하고 기록)

| ID | 기대 관찰 |
|---|---|
| S1 | B3: 100,000행에서 PK 조회의 조회당 페이지 읽기가 인덱스 없는 조회보다 수십 배 이상 적고 시간도 짧다 |
| S2 | B1 walSyncs = N, B2 walSyncs = 1 (+ checkpoint 시 2) |
| S3 | B8: 캐시가 커질수록 적중률이 감소하지 않는다 |
| S4 | B9: 복구 시간이 WAL 프레임 수에 대략 선형 |
| S5 | B4: 선택도 0.1%에서 인덱스가 빠르다. 교차점(인덱스가 느려지는 선택도)을 기록 |
| S6 | B3 콜드 캐시 PK 조회 1회의 물리 읽기 ≈ 트리 높이 + 1 |
| S7 | B7: `LIMIT 10`이 전체 정렬과 비슷한 시간(top-N 최적화 없음 — 예상된 관찰) |
| S8 | B10: pageCount 증가율 기록(DC-61, C.1.4 번복 조건 판단 근거) |

### K.6 최적화 규칙

측정 → 가설(어느 카운터가 왜) → 변경 → 재측정. 변경 후 `npm run check`, `npm run test:crash`를 다시 통과해야 하며, before/after JSON 두 개와 해석을 BENCHMARKS.md에 남긴다. fsync 지점·쓰기 순서는 최적화 대상이 아니다.

---

## L. Documentation Plan

| 문서 | 목적 | 내용(출처) | 작성 단계 | 정합성 검증 |
|---|---|---|---|---|
| `DESIGN_REVIEW.md` | 확정 설계(이 문서) | — | 완료 | 변경은 DECISIONS 경유 |
| `SPEC.md` | 언어·의미 명세 | F.1~F.11, DC-31~DC-44, H.2 오류 표 | P0 | `check-docs`: 오류 코드 집합. T-PAR-006: EBNF 대로 생성한 문장 수락 |
| `FORMAT.md` | 바이트 형식·버전 정책 | D 전부 | P0 | T-FMT-002 픽스처, 오프셋 상수는 `layout.ts` 한 곳 |
| `ARCHITECTURE.md` | 모듈·의존·인터페이스 | E | P0, P17 갱신 | T-ARCH-001 |
| `DURABILITY.md` | WAL 프로토콜·fsync·불변식·복구 | G.2~G.11, D1~D7, I13~I16 | P0 | `check-docs`: FSYNC 태그 ↔ F 목록, T-CRASH-004 |
| `TESTING.md` | 테스트 계층·ID·실행법·재현법 | J | P0, 단계마다 상태 갱신 | `check-docs`: T-ID 양방향 |
| `DECISIONS.md` | 설계 변경 이력 | `DEC-000`(이 문서 채택)부터, 형식: ID/날짜/변경/사유/영향 문서·테스트/관련 DC | P0~ | 리뷰: DESIGN_REVIEW와 다른 동작마다 DEC 존재 |
| `PROGRESS.md` | 재개용 상태 | N.3 템플릿 | P0~ | 커밋마다 갱신 |
| `BENCHMARKS.md` | 측정 결과·해석 | K | P16 | 결과 JSON 파일 경로 인용 |
| `README.md` | 소개·설치·사용·구조·테스트·제약 | 요약 | P17 | 예제 코드를 T-EXEC-001과 같은 내용으로 유지 |
| `LIMITATIONS.md` | 알려진 제약 | A.4, DC-19(중간 손상), DC-52, DC-53, DC-61, 크래시 검증 범위 | P17 | |
| `FUTURE.md` | Stretch·연기 항목 우선순위 | O | P17 | |
| `LEARNING.md` | 개념 → 코드 위치 → 검증 테스트 | 프로젝트 개요의 개념 목록 각각 | P17 | 각 행의 파일 경로·T-ID 존재를 `check-docs --final`이 검사 |
| `REVIEW_PACKET.md` | 독립 검토자용 요약 | 보장(원자성·내구성·무결성), 가정(fault model), 불변식 목록, F1~F5와 코드 위치, 테스트 실행법, 장애 주입 범위와 한계, 알려진 약점, 검토 우선순위 | P17 | 코드 위치는 `파일:줄` 표기, 최종 게이트에서 대조 |

---

## M. Implementation Phases

공통 규칙: 각 단계는 하위 단계의 **실제 구현만** 사용한다. 완료 조건의 테스트가 모두 통과하고 `npm run check`가 성공해야 커밋·태그한다(P0 제외). 예상 작업량은 세션 수(1 세션 = 한도 1회분).

### P0 — 설계 문서
- 작업: SPEC, FORMAT, ARCHITECTURE, DURABILITY, TESTING, DECISIONS(`DEC-000`), PROGRESS 작성. `.gitignore`(N.1 목록).
- 선행: 없음.
- 완료: 상수 대조표(4096/16/32/4060/512/4000/64/48/24/4120/2048/1000)가 FORMAT·DURABILITY·SPEC에서 일치. 문서 간 상호 대조 체크리스트를 PROGRESS에 기록.
- 커밋: `docs: define semantics, format, architecture and durability protocol`. 태그 `phase-00-done`. 작업량 0.5.

### P1 — 프로젝트 기반
- 작업: `package.json`(J.9 스크립트), `tsconfig.json`/`tsconfig.build.json`, vitest 설정 2개, `.gitattributes`, `scripts/check-any.mjs`, `scripts/check-docs.mjs`(기본 모드), `src/util/{prng,bytes,assert,utf8}.ts`, `src/errors/*`(H.2 전체 코드), 빈 `src/index.ts`.
- 선행: P0.
- 완료: T-ARCH-001, T-ARCH-003, T-PRNG-001, T-ERR-001, T-ERR-002(포맷터 단위). `npm run check` 성공. `package-lock.json` 커밋.
- 커밋: `chore: configure strict TypeScript, Vitest and checks`, `feat(errors): add error hierarchy and codes`. 작업량 0.75.

### P2 — 저장 기초
- 작업: `crc32.ts`, `layout.ts`, `vfs.ts`, `node-vfs.ts`, `memory-vfs.ts`(durable/pending 추적, `crashImage`), `fault-vfs.ts`, `lock.ts`(G.15), `page.ts`(공통 헤더·pageCrc·검증), `file-header.ts`.
- 선행: P1.
- 완료: T-CRC-001/002, T-VFS-001~008, T-PAGE-001~003, T-FMT-001, T-LOCK-001~004.
- 커밋: `feat(storage): add crc32, page layout and file header`, `feat(storage): add vfs implementations, locking and fault injection`. 작업량 1.

### P3 — WAL 모듈
- 작업: `wal.ts` — 헤더·프레임 코덱, `appendTxn(pages)`(프레임당 write 1회 + F4), `scan()`(G.7 `scanWal`), `reset(dbId)`(F2, F3), `readFramePage(n)`. `StorageFile`만 의존.
- 선행: P2.
- 완료: T-WAL-001~008, T-WAL-010. FSYNC 태그 F2, F3, F4 존재.
- 커밋: `feat(storage): add write-ahead log format, append, scan and reset`. 작업량 1.

### P4 — Pager 핵심
- 작업: `pager.ts`, `freelist.ts` — 캐시·LRU·pin(G.1~G.2), allocate/free(G.3), 트랜잭션·savepoint·롤백(G.3, G.5), 커밋(G.4), checkpoint(G.6), 오픈·생성·복구(G.7), close(G.8). 페이지 수준 무결성 함수(헤더·CRC·freelist).
- 선행: P3.
- 완료: T-PGR-001~012, T-PGR-014, T-PGR-015, T-WAL-009. FSYNC 태그 F1, F5 추가.
- 커밋(내부 3개): `feat(storage): add pager cache, pins and page allocation`, `feat(storage): add transactions, savepoints, WAL commit and recovery`, `feat(storage): add checkpoint and page-level model test`. 작업량 1.5~2.

### P5 — Pager 견고성과 페이지 수준 크래시
- 작업: FAILED 상태(G.11)와 오류 매핑, 자동 checkpoint(`checkpointDue`, `maybeCheckpoint()`), 통계 완성, PW1 crash matrix(짧은 스위트 + long 파일 골격에 PW1 등록), 복구 재크래시, 생성 크래시.
- 선행: P4.
- 완료: T-PGR-013, T-PGR-016, T-FAIL-001~004, T-STAT-001(Pager 수준), T-CRASH-P01~P03, T-CRASH-004(Pager 수준). `npm run test:crash`(PW1만) 통과.
- 커밋: `feat(storage): add failed state, auto checkpoint and page-level crash suite`. 작업량 1~1.5.

### P6 — 레코드 계층
- 작업: `value.ts`, `row-codec.ts`, `heap-page.ts`(G.12), `heap-file.ts`, 힙 구조 검사 함수(I5, I6, I7).
- 선행: P5.
- 완료: T-ROW-001~003, T-HP-001~005, T-HEAP-001~003.
- 커밋: `feat(record): add row codec, slotted pages and heap file`. 작업량 1.

### P7 — 카탈로그
- 작업: `schema.ts`, `catalog.ts`(D.7 적재·검증, 행 추가·삭제, RID 캐시), bootstrap `initialize`(Page 1), `engine/integrity.ts` v1(I1~I7, I12; 인덱스 소유권 제외), 픽스처 `empty-v1.db` 생성 스크립트(테스트 안에서 `UPDATE_FIXTURES=1`일 때만 쓰기).
- 선행: P6.
- 완료: T-CAT-001~004(인덱스 메타데이터는 테스트가 할당한 BTREE_LEAF 페이지로, 이 단계의 인덱스 테스트는 integrity 검사 제외), T-FMT-002.
- 커밋: `feat(catalog): persist table and index metadata`. 작업량 1.

### P8 — 렉서와 파서
- 작업: `tokens.ts`, `lexer.ts`, `ast.ts`(모든 노드 `pos`), `parser.ts`, `printer.ts`, 파서 케이스 표.
- 선행: P1(오류). (저장 계층과 독립이므로 P2 이후 언제든 가능하지만 순서는 유지.)
- 완료: T-LEX-001~005, T-PAR-001~006, T-ERR-002(SQL). SPEC EBNF와 대조 완료를 PROGRESS에 기록.
- 커밋: `feat(sql): add lexer, parser and AST printer`. 작업량 1.

### P9 — 분석기와 평가기
- 작업: `analyzer.ts`, `bound.ts`(F.4, F.7), `exec/eval.ts`(F.5).
- 선행: P7(스키마 타입), P8.
- 완료: T-ANA-001~004, T-EVAL-001~005.
- 커밋: `feat(sql): add analyzer and three-valued expression evaluator`. 작업량 1.

### P10 — 실행기와 Database API
- 작업: `plan.ts`, `planner.ts`(SeqScan만), `operators.ts`, `dml.ts`(G.14, PK 유일성은 힙 스캔), `ddl.ts`, `explain.ts`, `engine/database.ts`(문장 수명·트랜잭션 문·오류 감싸기·FAILED·close·락), `executeScript`, `integrityCheck()`/`stats()` API, 골든 테스트 러너와 초기 `tests/sql/*.sql`(최소 15개 파일: DDL, INSERT, SELECT, WHERE/NULL, ORDER BY, LIMIT, UPDATE, DELETE, 제약, 트랜잭션, 오류 위치, EXPLAIN, 경계값, 멀티바이트, 재오픈 없는 스크립트).
- 선행: P5, P7, P9.
- 완료: T-EXEC-001~015, T-GOLD-001, T-CAT-005, T-ERR-003, T-LIM-001, T-INTEG-001(힙), T-STAT-001(SQL), T-LOCK-004(close).
- 커밋(내부 3개): `feat(exec): add operators, seq-scan planner and DML/DDL execution`, `feat(engine): add Database API, transactions and statement atomicity`, `test: add SQL golden suite`. 작업량 1.5~2.

### P11 — 모델 기반 테스트 v1과 CLI
- 작업: `tests/model/*`(J.3, J.4), `tests/integration/model.test.ts`(짧게), `tests/long/random.long.test.ts`, `cli/*`(F.12).
- 선행: P10.
- 완료: T-MODEL-001, T-MODEL-003~005, T-ARCH-002, T-CLI-001~003. `SEEDS=200 npm run test:random` 통과.
- 커밋: `test: add model-based random testing`, `feat(cli): add REPL and script runner`. 작업량 1~1.5.

### P12 — B+tree
- 작업: `key-codec.ts`, `node.ts`(D.6), `btree.ts`(G.13), `check()`(I8~I10).
- 선행: P4. (SQL과 무관)
- 완료: T-KEY-001/002, T-BT-001~008.
- 커밋: `feat(index): add on-disk B+tree with fixed root and lazy delete`. 작업량 1.5.

### P13 — 인덱스 통합
- 작업: CREATE/DROP INDEX 실제 구현, CREATE TABLE이 PK 자동 인덱스 생성(카탈로그 검증 규칙 활성화), DML 인덱스 유지(G.14), 힙 스캔 유일성 → 인덱스로 교체, 플래너 IndexScan(F.8), EXPLAIN IndexScan, 무결성 I8~I11 + 인덱스 소유권, 차분 테스트, 모델 v2.
- 선행: P11, P12.
- 완료: T-IDX-001~005, T-PLAN-001/002, T-DIFF-001, T-MODEL-002, T-INTEG-001(인덱스). `SEEDS=200 npm run test:random` 통과.
- 커밋(내부 2개): `feat(engine): maintain indexes and enforce uniqueness via B+tree`, `feat(exec): add rule-based index planner and differential tests`. 작업량 1.5~2.

### P14 — SQL 수준 크래시·손상·무결성 완성
- 작업: CW1~CW6 crash matrix(J.5), 손상 테스트(J.6), 무결성 위반 주입 테스트.
- 선행: P13.
- 완료: T-CRASH-001~005, T-CORR-001~004, T-INTEG-002/003. `npm run test:crash` 전수 통과.
- 커밋: `test: add SQL-level crash matrix and corruption suite`. 작업량 1~1.5.

### P15 — 적대적 하드닝
- 체크리스트(각 항목에 결과를 PROGRESS에 기록, 결함은 재현 테스트 먼저):
  1. I의 모든 R에 연결된 T-ID가 존재·실행됨: `npm run check:docs -- --final`(T-TRACE-001).
  2. `SEEDS=1000 STEPS=1000 npm run test:random`, 전수 `npm run test:crash`, T-CRASH-005를 `SEEDS=200`.
  3. 경계 재점검: 행 4060/4061, 키 512/513, TEXT 4000/4001, 컬럼 64/65, 식별자 64/65, ±MAX_SAFE, 빈 테이블, 단일 행, 빈 문자열, 이모지, `LIMIT 0`, 같은 키 수백 개.
  4. 오라클 독립성 검토: 참조 모델이 구현 로직을 복제했는지(같은 헬퍼, 같은 알고리즘) 읽고 기록.
  5. 오류 경로: 모든 `throw` 지점이 H.2 코드를 쓰는지, `catch`가 오류를 삼키지 않는지 grep 검토.
  6. 런타임 불변식 I13~I16 assertion이 실제 코드에 있는지.
  7. FSYNC 태그와 DURABILITY 대조, opLog 패턴(T-CRASH-004) 재확인.
- 커밋: `test: adversarial hardening and fault coverage`(+ 발견 결함별 `fix(...)`). 작업량 1~2.

### P16 — 벤치마크
- 작업: `bench/run.ts`, `scenarios.ts`, `report.ts`, 결과 JSON, BENCHMARKS.md.
- 선행: P15.
- 완료: T-BENCH-001, K.5 건전성 확인 결과 기록.
- 커밋: `perf: add benchmark harness and results`. 작업량 1.

### P17 — 문서 마무리와 최종 게이트
- 작업: README, LEARNING, LIMITATIONS, FUTURE, REVIEW_PACKET, ARCHITECTURE 갱신. 코드 재독 체크리스트(중복 로직, 의존 방향, 책임 혼합, 안전하지 않은 assertion, `any`, dead code, 불필요한 추상화, 위치 정보 손실, 테스트되지 않은 공개 동작, 문서-구현 불일치, 임시 경로 잔존).
- 최종 게이트: 2단계 프롬프트의 Core Done Gate 1~11 + `npm run check:docs -- --final`.
- 커밋: `docs: finalize documentation and review packet`. 태그 `phase-17-done`. 작업량 1.

### M.1 단계 요약

| 단계 | 이름 | 선행 | 세션 |
|---|---|---|---|
| P0 | 설계 문서 | — | 0.5 |
| P1 | 프로젝트 기반 | P0 | 0.75 |
| P2 | 저장 기초 | P1 | 1 |
| P3 | WAL 모듈 | P2 | 1 |
| P4 | Pager 핵심 | P3 | 1.5~2 |
| P5 | Pager 견고성·페이지 크래시 | P4 | 1~1.5 |
| P6 | 레코드 | P5 | 1 |
| P7 | 카탈로그 | P6 | 1 |
| P8 | 렉서·파서 | P1 | 1 |
| P9 | 분석기·평가기 | P7, P8 | 1 |
| P10 | 실행기·Database API | P5, P7, P9 | 1.5~2 |
| P11 | 모델 테스트 v1·CLI | P10 | 1~1.5 |
| P12 | B+tree | P4 | 1.5 |
| P13 | 인덱스 통합 | P11, P12 | 1.5~2 |
| P14 | SQL 크래시·손상 | P13 | 1~1.5 |
| P15 | 하드닝 | P14 | 1~2 |
| P16 | 벤치마크 | P15 | 1 |
| P17 | 문서·최종 게이트 | P16 | 1 |
| 합계 | | | 약 18~26 |

---

## N. Git & PROGRESS.md Rules

### N.1 Git 규칙

- 브랜치: `main` 하나. rebase·amend·force push·이력 재작성 금지.
- 커밋 메시지: `type(scope): subject`, type ∈ {`feat`, `fix`, `test`, `docs`, `chore`, `perf`, `refactor`}, scope ∈ {`storage`, `record`, `index`, `catalog`, `sql`, `exec`, `engine`, `cli`, `errors`, `bench`} 또는 생략. subject는 영어 명령형, 72자 이하.
- 커밋 전 `npm run check` 통과 필수(P0 문서 전용 커밋만 예외). 실패 상태 코드는 완료 커밋 금지.
- stage는 파일을 명시해서(`git add <paths>`). `git add -A`/`git add .` 금지.
- 각 커밋에 `PROGRESS.md` 갱신을 포함한다.
- 단계 완료 시 태그 `phase-NN-done`(두 자리: `phase-00-done` … `phase-17-done`).
- 커밋 금지: `*.db`, `*.db-wal`, `*.db-lock`, `dist/`, `coverage/`, `bench/results/tmp/`. 허용 fixture: `tests/fixtures/` 아래 작은 파일(≤ 64 KiB).
- `.gitignore`(P0): `node_modules/`, `dist/`, `coverage/`, `*.db`, `*.db-wal`, `*.db-lock`, `bench/results/tmp/`, 그리고 예외 `!tests/fixtures/*.db`.
- 저장소 신원이 없으면 이 저장소 local config에만 임시 값 설정(global 수정 금지).
- 한도 직전 미완 작업: 테스트가 통과하지 않는 코드는 커밋하지 않고 PROGRESS의 "미커밋 변경"에 파일 목록·소유 단계·상태를 적는다. 단 PROGRESS.md 자체는 `docs(progress): checkpoint session state` 커밋으로 남길 수 있다(이때 코드 파일은 stage하지 않음, `npm run check` 예외로 허용).

### N.2 세션 절차

**시작**
1. `PROGRESS.md`, `DESIGN_REVIEW.md`(필요 섹션), `DECISIONS.md`, 해당 단계 관련 문서(SPEC/FORMAT/DURABILITY) 읽기.
2. `git status`, `git log --oneline -20`, `git tag`.
3. `npm run check`로 기준선 확인. 깨져 있으면 복구가 최우선.
4. "현재 실패"가 있으면 그 재현부터, 없으면 "다음 최소 행동"부터.
5. 작업 전에 PROGRESS의 "지금 하던 일(INTENT)"을 먼저 갱신.

**작업 중**
- 논리 단위(M의 내부 커밋 단위)마다: 테스트 작성 → 실패 확인 → 구현 → 통과 → `npm run check` → 문서 갱신 → PROGRESS 갱신 → 커밋.
- 같은 원인 실패 2회 → 같은 패치 반복 금지, PROGRESS "현재 실패"에 가설을 적고 접근 변경.

**중단(한도 임박 또는 종료)**
1. 진행 중 변경이 통과 상태면 커밋. 아니면 미커밋으로 두고 PROGRESS에 정확히 기록.
2. PROGRESS: 현재 단계 상태, 마지막 커밋, 마지막 check 결과(실제로 실행한 것만), 현재 실패(명령·핵심 오류·seed·가설), 다음 최소 행동(파일·테스트 이름까지).
3. 한도로 끊긴 단계를 완료로 표시하지 않는다.

**재개**
- 미커밋 변경이 있으면 `git diff`로 PROGRESS 기록과 대조. 기록과 다르면 기록을 믿지 말고 diff를 기준으로 상태를 다시 적는다.
- 완료된 단계를 다시 만들지 않는다.

### N.3 PROGRESS.md 템플릿

```markdown
# PROGRESS

## 현재 상태
- 기준 설계: DESIGN_REVIEW.md (변경 이력: DECISIONS.md, 최신 DEC-NNN)
- 현재 단계: PNN <이름> (not-started | in-progress | verified | committed)
- 마지막 커밋: <hash> <subject>   ← 실제로 존재하는 커밋만
- 마지막 `npm run check`: pass | fail — 테스트 N개, <날짜/세션 번호>
- 마지막 `test:random` / `test:crash`: <결과, SEEDS, 날짜> | 미실행
- 환경: Node <ver>, npm <ver>, <OS>

## 단계 체크리스트
| 단계 | 상태 | 커밋/태그 | 비고 |
|---|---|---|---|
| P0 설계 문서 | | | |
| P1 프로젝트 기반 | | | |
| P2 저장 기초 | | | |
| P3 WAL 모듈 | | | |
| P4 Pager 핵심 | | | |
| P5 Pager 견고성·페이지 크래시 | | | |
| P6 레코드 | | | |
| P7 카탈로그 | | | |
| P8 렉서·파서 | | | |
| P9 분석기·평가기 | | | |
| P10 실행기·Database API | | | |
| P11 모델 테스트 v1·CLI | | | |
| P12 B+tree | | | |
| P13 인덱스 통합 | | | |
| P14 SQL 크래시·손상 | | | |
| P15 하드닝 | | | |
| P16 벤치마크 | | | |
| P17 문서·최종 게이트 | | | |

## 지금 하던 일 (INTENT)
- (시작 전에 쓴다) 무엇을, 어떤 파일/테스트 ID로

## 현재 실패 / 막힌 점
- 명령: 
- 핵심 오류: 
- 재현: SEED= / CRASH_CASE= 
- 원인 가설: 
- 시도한 것(같은 원인 반복 횟수): 

## 다음 최소 행동
- 바로 재개할 작업 1~3개 (파일 경로, 테스트 ID)

## 남은 위험
| R-ID | 대응 테스트 상태 | 미해결 원인 |
|---|---|---|

## 미커밋 변경
| 파일 | 소유 단계 | 상태(작성 중/테스트 실패/통과) |
|---|---|---|

## 문서 대조 체크 (단계 종료 시)
- [ ] SPEC/FORMAT/DURABILITY/TESTING 갱신
- [ ] DECISIONS에 설계 이탈 기록
- [ ] check:docs 통과
```

---

## O. Open Questions & Deferred

### O.1 Stretch 우선순위 (FUTURE.md 순서)

| 순위 | 항목 | 이유 | 선행 |
|---|---|---|---|
| 1 | 집계 `COUNT/SUM/MIN/MAX` | 실행기 연산자 하나로 학습 가치 큼 | P13 |
| 2 | `GROUP BY` | 집계의 자연스러운 확장(해시 또는 정렬 기반) | 1 |
| 3 | 두 테이블 `INNER JOIN`(nested loop → index nested loop) | 플래너 학습 | P13 |
| 4 | 자동 checkpoint 정책 튜닝 | B9 결과 기반 | P16 |
| 5 | B+tree 병합·재분배 | C.1.4 번복 조건 충족 시 | P12 |
| 6 | 복합 인덱스 | 키 인코딩 확장(접두사 문제 재검토 필요) | P13 |
| 7 | `REAL` 타입 | 정렬 가능 부동소수 인코딩, NaN 규칙 필요 | — |

### O.2 이 검토에서 범위 밖으로 미룬 항목

| 항목 | 미룬 이유 | 재검토 조건 |
|---|---|---|
| SELECT 목록 표현식·별칭, ORDER BY 표현식 | Core 축소 | 집계 도입 시 함께 |
| `IF [NOT] EXISTS`, 따옴표 식별자 | 편의 기능 | 사용자 요구 |
| 힙 free-space map | DC-61 | B10 팽창이 심할 때 |
| 인덱스 순서 스캔으로 ORDER BY 제거, top-N 정렬 | 플래너 단순화 | S7 관찰 후 |
| 파일 축소(VACUUM) | 범위 | 없음 |
| int64 전 범위(bigint) | C.1.5 | 요구 시(포맷 불변) |
| 읽기 전용 오픈 모드, 손상 DB salvage | DC-49 | 요구 시 |
| 실제 전원 차단·OS 크래시 시험 | 환경 한계 | 별도 실험 프로젝트 |
| Windows 디렉터리 내구성 검증 | Node API 한계 | 없음(LIMITATIONS) |
| WAL 중간 손상 탐지(크래시 꼬리와 구분) | 체인 구조상 구분 불가 | 프레임에 트랜잭션 번호·주기 마커 추가 시(포맷 v2) |
| 오버플로 페이지(큰 행) | Non-goal | — |
| prepared statement/파라미터 바인딩 | Non-goal | — |

### O.3 열린 질문 (모두 기본 결정 완료, 구현 중 확인)

| 질문 | 현재 결정 | 확인 방법·번복 조건 |
|---|---|---|
| Windows에서 `process.kill(pid, 0)`이 PID 생존 확인에 충분한가 | 사용(DC-52) | T-LOCK-003이 Windows에서 실패하면 "파싱 가능한 락 = 항상 잠김 + 오류 메시지에 수동 삭제 안내"로 단순화하고 DEC 기록 |
| `cachePages` 2048 기본값이 학습용 벤치마크에 적절한가 | 2048 | B8 결과가 기본값에서 적중률 < 50%면 재검토 |
| `walAutoCheckpointFrames` 1000이 적절한가 | 1000 | B9에서 1000프레임 복구 > 1초면 낮춤 |
| 모델 테스트 기본 seed·step 수가 60초 예산 안에 드는가 | 20 × 300 | P11에서 측정해 TESTING에 기록, 초과 시 축소 |
| Node 20에서 `fsyncSync`/`ftruncateSync` 동작 차이 | 없음으로 가정 | CI가 없으므로 Node 20 수동 실행 1회를 P17 게이트에 포함(가능한 경우), 못 하면 LIMITATIONS에 "Node 24에서만 검증" 기록 |

---

출력 체크리스트: A ✅ · B ✅ · C ✅ · D ✅ · E ✅ · F ✅ · G ✅ · H ✅ · I ✅ · J ✅ · K ✅ · L ✅ · M ✅ · N ✅ · O ✅
