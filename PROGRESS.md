# PROGRESS

## 현재 상태
- 기준 설계: DESIGN_REVIEW.md rev1 (변경 이력: DECISIONS.md, 최신 DEC-008)
- 현재 단계: P17 문서·최종 게이트 (committed) — Core 완료. 이후 독립 리뷰(CLAUDE_INDEPENDENT_REVIEW.md) + 리뷰 후속 수정 R1 완료(committed)
- 마지막 커밋: `git log -1` 참조(단계 태그 phase-NN-done)
- 마지막 `npm run check`: pass — 테스트 167개, 156/156 test ID, 2026-10-04 리뷰 후속(R1)
- 마지막 `test:random` / `test:crash`: R1 후 기본 설정 pass(3/3, 56초 / 6/6 — T-CRASH-006 포함, 34초). 리뷰 스위트 `vitest.review.config.ts` 29/29. P15에서 SEEDS=1000, 리뷰에서 SEEDS=600·T-CRASH-005 SEEDS=300 pass. 2026-10-04
- Node v20.20.2(Windows): typecheck·check:any·check:docs·npm test(167)·리뷰 스위트(29)·test:random(3)·test:crash(6) pass, R1 후 재실행
- 환경: Node v24.16.0(기본)·v20.20.2, npm 11.13.0, Windows 11 Pro 10.0.26200

## 단계 체크리스트
| 단계 | 상태 | 커밋/태그 | 비고 |
|---|---|---|---|
| P0 설계 문서 | committed | phase-00-done | SPEC/FORMAT/ARCHITECTURE/DURABILITY/TESTING은 rev1에서 추출 |
| P1 프로젝트 기반 | committed | phase-01-done | TypeScript 5.x 고정(DEC-001), assert 위치(DEC-002) |
| P2 저장 기초 | committed | phase-02-done | VFS 세부(DEC-003), T-LOCK-003으로 Windows process.kill(pid,0) 확인 |
| P3 WAL 모듈 | committed | phase-03-done | FSYNC-F2/F3/F4 태그 |
| P4 Pager 핵심 | committed | phase-04-done | 변이 확인: Page 0 제자리 복원 제거 시 T-PGR-008/012 실패 |
| P5 Pager 견고성·페이지 크래시 | committed | phase-05-done | |
| P6 레코드 | committed | phase-06-done | 힙 런타임 체인 손상은 RECORD_MALFORMED로 보고 |
| P7 카탈로그 | committed | phase-07-done | REQUIRE_PK_INDEX=false (P13에서 true로), 픽스처 tests/fixtures/empty-v1.db |
| P8 렉서·파서 | committed | phase-08-done | SPEC EBNF 대조: T-PAR-001(생성 규칙별 정상/오류)과 T-PAR-006(EBNF 생성기 1500문장) 통과. 한도 상수 위치 DEC-004 |
| P9 분석기·평가기 | committed | phase-09-done | SELECT는 테이블 해석 후 목록 검사(테이블 없이는 컬럼 해석 불가) |
| P10 실행기·Database API | committed | phase-10-done | 골든 16개 수동 검토. 임시 경로: exec/ddl.ts CREATE/DROP INDEX → UsageError (P13에서 제거) |
| P11 모델 테스트 v1·CLI | committed | phase-11-done | 변이 확인: NULL 정렬·UPDATE 유일성 버그를 모델이 검출. DEC-005(executeScript 콜백, db.schema). P13에서 cli.test .indexes 기대값 갱신 필요 |
| P12 B+tree | committed | phase-12-done | 변이 확인: 분할 시 리프 연결 누락을 T-BT-002/004/005/006이 검출 |
| P13 인덱스 통합 | committed | phase-13-done | 임시 CREATE/DROP INDEX 경로 제거됨. 모델 생성기에 긴 TEXT 추가(행 이동 변이 검출 확인). DEC-006 |
| P14 SQL 크래시·손상 | committed | phase-14-done | 변이 확인: 커밋 fsync 제거·checkpoint 순서 역전을 crash matrix가 검출 |
| P15 하드닝 | committed | phase-15-done | 체크리스트 결과는 하단 섹션 |
| P16 벤치마크 | committed | phase-16-done | 건전성 S1~S8 기록, 최적화 없음 |
| P17 문서·최종 게이트 | committed | phase-17-done | 최종 게이트 1~11 + check:docs --final 통과 |

## 지금 하던 일 (INTENT)
- 없음 (Core 완료). 다음 작업은 FUTURE.md의 Stretch 우선순위

## 현재 실패 / 막힌 점
- 없음
- 임시 unsupported 경로: 없음(P13에서 제거)

## 다음 최소 행동
- 없음(Core + 검증 종료). 남은 항목은 FUTURE.md(리뷰 TG-3~TG-6, L-2 원자적 락 인수 포함)

## 남은 위험
| R-ID | 대응 테스트 상태 | 미해결 원인 |
|---|---|---|
| R01~R38 | 모두 테스트 존재·통과(check:docs --final) | 실제 전원 차단·Windows 디렉터리 내구성은 모델 밖(LIMITATIONS) |

## 미커밋 변경
| 파일 | 소유 단계 | 상태 |
|---|---|---|

## 문서 대조 체크 (P0)
- [x] 상수 대조: 4096/16/32/4060/512/4000/64/48/24/4120/2048/1000 — SPEC/FORMAT/DURABILITY는 DESIGN_REVIEW rev1에서 기계적으로 추출되어 동일 값
- [x] SPEC에 EBNF·타입·NULL·오류 코드, FORMAT에 모든 바이트 레이아웃, DURABILITY에 F1~F5·I1~I16·D1~D7
- [x] DECISIONS에 DEC-000

## P15 하드닝 체크리스트 결과
1. 추적성: `npm run check:docs -- --upto=15`(T-TRACE-001) 통과 — I의 모든 T-ID와 J.2의 P15 이하 ID에 테스트 존재(T-BENCH-001만 P16).
2. 긴 실행: SEEDS=1000 STEPS=1000 test:random, 전수 test:crash + T-CRASH-005 SEEDS=200 — 결과는 아래 현재 상태 줄에 기록.
3. 경계값: 행 4060/4061(T-ROW-002, T-EXEC-013), 키 512/513(T-KEY-002, T-IDX-005), TEXT 4000/4001(T-LEX-005, T-LIM-001), 컬럼 64/65, 식별자 64/65, ±MAX_SAFE(T-EVAL-003, 골든 013), 빈 테이블·단일 행(hardening T-EXEC-006), 빈 문자열·이모지(골든 014), LIMIT 0(T-EXEC-006), 같은 키 수백 개(T-BT-005, hardening T-IDX-004) — 전부 존재·통과.
4. 오라클 독립성: tests/model은 src를 PRNG 외 import하지 않음(T-ARCH-002). 산술은 BigInt, 텍스트 비교는 Buffer.compare, 정렬·유일성·3값 논리를 자체 구현(엔진은 Number·TextEncoder·B+tree). 공유 로직 없음. 변이 확인 4건(NULL 정렬, UPDATE 유일성, 행 이동 인덱스 갱신, 분할 시 리프 연결)을 독립 오라클/테스트가 검출.
5. 오류 경로: src의 throw는 모두 MiniDbError 계열(남아 있던 TypeError 1건을 InternalError로 교체). catch는 (a) 재throw, (b) 무결성 이슈로 보고, (c) 문서화된 무시(락 해제 실패, 락 파일 판독 실패 → 잠김 처리, UTF-8 디코딩 실패 → RECORD_MALFORMED)만 존재.
6. 런타임 불변식: I13(pager.checkNoPins), I14(beginTxn invariant), I15(WAL index 프레임 범위 invariant, P15에서 추가), I16(데이터 파일 write는 checkpoint/recovery 경로에만 — T-CRASH-004 opLog 패턴으로 검증).
7. FSYNC 태그 F1~F5 각각 존재(check:docs), opLog 패턴 T-CRASH-004(페이지·SQL 수준) 통과. 변이 확인: 커밋 fsync 제거·checkpoint 순서 역전을 crash matrix가 검출.

## 독립 리뷰 후속 (R1)
| 항목 | 조치 | 커밋 |
|---|---|---|
| 리뷰 산출물 보존 | CLAUDE_INDEPENDENT_REVIEW.md, tests/review, vitest.review.config.ts | 4baac75 |
| L-1 API 인수 오용 → FAILED | execute/executeScript 인수 검사 → UsageError INVALID_OPTION, T-ERR-004 | 7f5396d |
| TG-1 I11 count-only 변이 생존 | T-INTEG-004를 main suite에 편입, 변이 M11을 npm run check가 검출함을 재확인 | 1980a97 |
| TG-2 복구 재크래시 정책 | T-CRASH-006(P-TORN·P-RANDOM·이중 크래시)을 test:crash에 편입, 변이 M2 단독 검출 확인 | 21960cd |
| DG-1~DG-5, L-2 문서화 | DEC-007, DURABILITY I1·DC-49·DC-52·G.15, SPEC, REVIEW_PACKET, LIMITATIONS, FUTURE | 이 문서 커밋 |
| onResult callback 예외 → FAILED (R2) | 원래 예외 그대로 전파, FAILED 아님, DEC-008, T-ERR-005 | 이 커밋 |

## 학습·포트폴리오 자료 (Core 종료 후)
- docs/study/MINI_DB_CORE_WALKTHROUGH.md(설명·코드 추적·Self Check 35문항). src·tests 변경 없음.
- Linux/WSL 검증: 이 환경에 WSL·Docker가 설치되어 있지 않아 수행하지 않음(LIMITATIONS의 "Linux/macOS 미실행" 유지).
