# DECISIONS

설계 변경 이력. 형식: `DEC-NNN` / 날짜 / 변경 / 사유 / 영향 문서·테스트 / 관련 DC.
`DESIGN_REVIEW.md`와 다르게 구현하는 모든 사항은 여기에 먼저 기록한다.

## DEC-000 — DESIGN_REVIEW.md rev1 채택
- 날짜: 2026-10-04
- 변경: `DESIGN_REVIEW.md` **rev1**(Page 0 롤백 시 제자리 복원, P6 선행 조건 P5 통일 포함)을 확정 설계로 채택한다.
- 사유: 구현 전 설계 검토와 정합성 점검 완료.
- 영향: SPEC/FORMAT/ARCHITECTURE/DURABILITY/TESTING은 `scripts/gen-docs-from-design.mjs`로 rev1에서 그대로 추출했다.
- 관련 DC: 전체.

## DEC-001 — TypeScript 5.x 고정
- 날짜: 2026-10-04
- 변경: devDependency `typescript`를 `^5`(현재 5.9.3)로 고정한다.
- 사유: npm `latest`인 TypeScript 7(네이티브 컴파일러)은 `createSourceFile` 등 JS 컴파일러 API를 기본 export로 제공하지 않아, `check-any.mjs`와 T-ARCH-001(J.9, E.2)이 의존하는 AST 검사를 할 수 없다.
- 영향: package.json. 설계 동작 변화 없음.
- 관련 DC: DC-02, DC-04.

## DEC-002 — `assertNever`/`invariant`의 위치
- 날짜: 2026-10-04
- 변경: E.1은 `assertNever`를 `util/`에 두었으나 `src/errors/assert.ts`로 둔다.
- 사유: 두 함수는 `InternalError`를 던지는데, E.2 의존 표에서 `util`은 `errors`를 import할 수 없다(`errors → util`만 허용).
- 영향: ARCHITECTURE E.1 서술과 파일 위치만 다름. 의존 방향 규칙은 그대로.
- 관련 DC: E.1, E.2.

## DEC-003 — VFS 인터페이스 세부
- 날짜: 2026-10-04
- 변경: (1) `CrashPolicy`에 `'torn-only'`를 추가해 J.5의 P-TORN을 직접 표현한다(E.4는 3개 정책만 나열). (2) `Vfs.syncDir()`는 실제 수행 여부를 `boolean`으로 반환한다(DC-53의 `stats.io.dirSyncs` 집계용). (3) `FaultPlan.failReadAt`(읽기 I/O 오류 주입, T-FAIL-003용)을 추가. (4) 잠금(G.15)의 Node 구현은 `node:fs` 소유 규칙(E.2)에 따라 `storage/node-vfs.ts` 안에 둔다(`storage/lock.ts` 없음).
- 사유: J.5·T-FAIL-003·DC-53을 구현하는 데 필요한 표현력. 동작 의미는 설계와 같다.
- 영향: ARCHITECTURE E.4/E.5 서술. 테스트 T-VFS-005, T-FAIL-003.
- 관련 DC: DC-03, DC-52, DC-53.

## DEC-004 — 언어 한도 상수의 위치
- 날짜: 2026-10-04
- 변경: `MAX_KEY_BYTES`, `MAX_TEXT_BYTES`, `MAX_COLUMNS`, `MAX_IDENTIFIER_BYTES`, `MAX_SAFE`를 `src/util/limits.ts`에 정의하고 `storage/layout.ts`는 재export만 한다. `MAX_ROW_BYTES`(페이지 레이아웃에서 유도)는 `layout.ts`에 남긴다.
- 사유: E.2 의존 표에서 `sql`은 `storage`를 import할 수 없는데 렉서·분석기가 이 한도를 쓴다.
- 영향: 상수 값 불변. T-ARCH-001.
- 관련 DC: DC-11~DC-14, E.2.

## DEC-005 — 공개 API 보조 기능과 스크립트 오류 범위
- 날짜: 2026-10-04
- 변경: (1) `executeScript(sql, onResult?)`: 문장마다 결과를 콜백으로 전달(CLI가 뒤 문장 오류 전에 앞 결과를 출력하기 위함). (2) `db.schema(): TableInfo[]` 추가(CLI `.tables/.schema/.indexes`는 공개 API만 쓸 수 있으므로, E.2). (3) `executeScript`의 렉서 오류(닫히지 않은 문자열 등)는 스크립트 전체를 실행 전에 거부하며 `statementIndex`는 그때까지 반환된 문장 수(=0)다. 구문 오류는 해당 문장 직전까지 실행된다.
- 사유: F.12 CLI 요구사항과 E.2 의존 규칙을 함께 만족. 렉서는 스크립트 전체를 한 번에 토큰화한다.
- 영향: SPEC F.12, E.4 Database 인터페이스. T-CLI-*, T-EXEC-012.
- 관련 DC: DC-57, DC-59.

## DEC-006 — 키로 인코딩할 수 없는 TEXT 리터럴은 인덱스 경계가 아니다
- 날짜: 2026-10-04
- 변경: F.8 규칙 3에 조건 추가 — UTF-8 512바이트를 넘는 TEXT 리터럴과의 비교는 인덱스 가능 conjunct가 아니다(Filter가 처리).
- 사유: 그런 값은 `encodeKey`가 `KEY_TOO_LARGE`를 던지므로, **플래너 자신이** 인덱스 유무에 따라 같은 SELECT를 오류/성공으로 가르게 된다(DC-70, T-DIFF-001 위반). 그런 값은 인덱스에 존재할 수 없으므로 결과는 같다.
- 범위(DEC-007에서 명확화): 이 규칙은 플래너가 만드는 오류에만 해당한다. 행을 평가할 때의 런타임 오류(예: WHERE의 `INTEGER_OVERFLOW`)는 DC-43("실제로 평가된 행·식에서만 오류, 어떤 행이 평가되는지는 플랜에 따라 다를 수 있음")을 따르므로 SeqScan과 IndexScan 사이에 달라질 수 있다. 예: `SELECT id FROM t WHERE x * 2 > 0 AND id = 1`은 PK 인덱스로는 성공, `forceSeqScan`으로는 `INTEGER_OVERFLOW`(tests/review/sql-probe.review.test.ts).
- 영향: SPEC F.8, T-IDX-005, T-PLAN-001.
- 관련 DC: DC-11, DC-43, DC-70.

## DEC-007 — 독립 리뷰 후속: 문서 정정과 API 인수 검증
- 날짜: 2026-10-04
- 근거: CLAUDE_INDEPENDENT_REVIEW.md(커밋 4baac75)의 L-1, L-2, DG-1~DG-5. 확정 의미(DESIGN_REVIEW.md rev1)는 바꾸지 않는다. 아래는 파생 문서의 표현을 실제(그리고 의도된) 동작에 맞춘 것이다.
- 변경:
  1. L-1: `execute`/`executeScript`가 인수 타입을 검사해 오용 시 `UsageError INVALID_OPTION`(SPEC H.5 "UsageError: 변경 없음/그대로" 구현). 이전에는 TypeError가 InternalError로 감싸져 FAILED가 되었다. T-ERR-004.
  2. DG-1(DURABILITY I1): 데이터 파일 크기 조건은 WAL이 빈 경우에만 `= pageCount×4096`. WAL에 커밋 이미지가 있으면 데이터 파일이 더 작을 수 있다(코드 `integrity.ts`가 원래 그렇게 검사).
  3. DG-2(DC-49): FAILED 이후에도 `close()`와 읽기 전용 진단 접근(`state`, `inTransaction`, `stats()`, `resetStats()`)은 허용됨을 명시. 데이터 접근 호출만 `DB_FAILED`.
  4. DG-3(DEC-006): 플래너 오류(DEC-006)와 행 평가 런타임 오류(DC-43)를 구분.
  5. DG-4(REVIEW_PACKET §1): 비트 플립 탐지 범위를 과장하지 않도록 수정(WAL 중간 손상 = 꼬리 폐기, 더 새 WAL 이미지가 있는 데이터 페이지 손상은 checkpoint가 덮어써 보고되지 않을 수 있음).
  6. DG-5: Node v20.20.2(Windows)에서 typecheck·check:any·check:docs·npm test·test:random·test:crash·리뷰 스위트 통과를 기록. Node 20의 다른 OS는 미검증.
  7. L-2: stale 락 인수의 다중 프로세스 경쟁을 DC-52·G.15·LIMITATIONS에 기록. 락 코드는 변경하지 않음(원자적 인수는 FUTURE).
- 테스트 추가: T-ERR-004(L-1), T-INTEG-004(TG-1, I11 내용 비교), T-CRASH-006(TG-2, 복구 재크래시 확장).
- 관련 DC: DC-26, DC-43, DC-49, DC-51, DC-52, DC-70.

## DEC-008 — `onResult` callback 예외는 사용자 코드의 예외로 그대로 전파한다
- 날짜: 2026-10-04
- 문제: `executeScript(sql, onResult)`에서 callback이 던진 예외가 `Database.wrap()`(DC-51)에 도달해 `InternalError INVARIANT_VIOLATION`으로 감싸지고 핸들이 FAILED가 되었다. 엔진 오류가 아니라 사용자 코드의 오류이므로 DC-49/DC-51의 FAILED 대상(저장소 실패·손상·엔진 버그)에 해당하지 않는다.
- 검토한 대안: (a) `UsageError`로 감싸기 — API 인수 오용(DEC-007)이 아니라 실행 중 사용자 코드 실패이며, 원래 예외 타입·정보를 잃는다. (b) 원래 예외 그대로 전파 — JS callback 관례(`Array.prototype.forEach` 등)와 같고 새 오류 코드·클래스가 필요 없다. **(b) 선택.**
- 변경: callback 호출을 별도 경계로 분리해, callback이 던진 값은 `guard`를 그대로 통과한다(감싸지 않음, `statementIndex` 미부여, FAILED 아님). 스크립트는 그 지점에서 중단한다.
- 의미: callback은 문장이 완료된 뒤 호출된다(자동 커밋이면 커밋 후 = durable, 명시적 트랜잭션이면 문장 savepoint 해제 후). 따라서 callback 예외는 그 문장이나 이전 문장을 롤백하지 않으며(DC-59 "이전 문장 효과 유지"), 이후 문장은 실행되지 않고, 열린 명시적 트랜잭션은 열린 채로 남아 호출자가 COMMIT/ROLLBACK을 결정한다. callback 안에서 호출한 `db.execute` 등이 던진 MiniDbError는 그 호출의 의미(예: CorruptionError → FAILED)를 그대로 유지한다.
- 영향: SPEC 구현 반영, DURABILITY DC-51 예외 열, T-ERR-005. 엔진 내부 InternalError/CorruptionError/저장소 실패의 FAILED 의미는 바뀌지 않음(T-ERR-003, T-FAIL-001~004).
- 관련 DC: DC-49, DC-51, DC-59.
