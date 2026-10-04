# Mini DB — FORMAT

데이터 파일·WAL 파일의 바이트 단위 형식과 버전 정책. 오프셋 상수는 `src/storage/layout.ts` 한 곳에만 정의한다.

> 출처: `DESIGN_REVIEW.md` rev1의 해당 섹션을 그대로 옮겼다(섹션 번호 유지). 변경은 `DECISIONS.md`에 기록한 뒤 두 문서를 함께 고친다.

## D.0 공통 규칙

- 파일: 데이터 파일 `<path>`, WAL `<path>-wal`, 락 `<path>-lock`(텍스트 `pid\n`, 체크섬 없음).
- 페이지 크기 `PAGE_SIZE = 4096`. 페이지 p의 데이터 파일 오프셋 = `p × 4096`.
- 정수는 표에 따로 적지 않으면 **부호 없는 리틀 엔디안**(u8/u16/u32). `i64`는 2의 보수 리틀 엔디안.
- "예약" 필드는 쓸 때 0으로 쓰고 v1 리더는 값을 해석하지 않는다(CRC가 변조를 잡는다).
- CRC32는 DC-08 정의. "페이지 CRC"는 4096바이트 전체를 offset 4..8을 0으로 간주하고 계산한 값.
- 사용하지 않는 바이트(slot 디렉터리와 레코드 영역 사이 등)는 0으로 쓸 의무가 없다(CRC 범위에는 포함). 단 **새로 초기화한 페이지는 전부 0에서 시작**한다(결정적 바이트, T-FMT-002).

## D.1 공통 페이지 헤더 (모든 페이지, 16바이트)

| 오프셋 | 크기 | 타입 | 필드 | 규칙 |
|---|---|---|---|---|
| 0 | 1 | u8 | `pageType` | 1=HEADER, 2=HEAP, 3=BTREE_INTERNAL, 4=BTREE_LEAF, 5=FREE. 그 외 → `CorruptionError PAGE_TYPE_INVALID` |
| 1 | 1 | u8 | `flags` | 0 (예약) |
| 2 | 2 | u16 | 예약 | 0 |
| 4 | 4 | u32 | `crc32` | 페이지 CRC. 불일치 → `PAGE_CHECKSUM_MISMATCH` |
| 8 | 4 | u32 | `pageId` | 자기 페이지 번호. 불일치 → `PAGE_ID_MISMATCH`(잘못된 위치에 쓴 페이지 탐지) |
| 12 | 4 | u32 | 예약 | 0 |

검증 순서(물리 읽기마다): CRC → pageId → pageType. Page 0은 CRC보다 **magic을 먼저** 검사한다(아무 파일이나 열었을 때 `NOT_A_DATABASE`를 내기 위해).

## D.2 Page 0 — 파일 헤더 (pageType = 1)

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

## D.3 HEAP 페이지 (pageType = 2) — slotted page

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

## D.4 행(레코드) 인코딩

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

## D.5 FREE 페이지 (pageType = 5)

| 오프셋 | 크기 | 필드 | 규칙 |
|---|---|---|---|
| 0 | 16 | 공통 헤더 | |
| 16 | 4 | `nextFree` u32 | 다음 FREE 페이지, 0 = 끝 |
| 20 | 4076 | 0 | 해제 시 페이지 전체를 0으로 초기화 후 헤더 기록 |

- freelist = 헤더 `freelistHead`에서 시작하는 단일 연결 리스트(LIFO). 할당: head를 꺼냄. 해제: 해제 페이지를 새 head로.

## D.6 B+tree 노드 (pageType = 3 내부, 4 리프)

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

## D.7 카탈로그 (`mdb_catalog`, Page 1 head의 HEAP 체인)

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

## D.8 WAL 파일 (`<path>-wal`)

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

## D.9 포맷 버전 정책

1. 데이터 파일 `formatVersion`과 WAL `walVersion`은 독립적이며 v1은 둘 다 1.
2. D.1~D.8의 어떤 바이트 의미든 바뀌면(필드 추가가 예약 영역을 쓰는 경우 포함) 해당 버전을 올린다.
3. v1 구현은 다른 버전을 읽지도 고치지도 않는다(`UNSUPPORTED_FORMAT_VERSION`). 마이그레이션 도구는 범위 밖.
4. 포맷 안정성 테스트: 고정 entropy로 만든 빈 DB의 바이트를 `tests/fixtures/empty-v1.db`(8192바이트)와 비교(T-FMT-002). 이 픽스처가 바뀌는 커밋은 반드시 버전 정책 검토를 DECISIONS에 남긴다.
5. `FORMAT.md`는 이 섹션의 표를 그대로 옮기고, 코드의 오프셋 상수는 한 파일(`src/storage/layout.ts`)에만 정의한다.

### 파일 형식

| ID | 영역 | 확정 규칙 | 예시·경계 | 번복 조건 |
|---|---|---|---|---|
| DC-05 | 페이지·엔디안 | 페이지 4096바이트 고정. 모든 다바이트 정수 필드는 **리틀 엔디안**. 예외: B+tree 키 바이트 안의 INTEGER 인코딩은 순서 보존용 **빅 엔디안** | `pageSize` 필드 ≠ 4096이면 `CorruptionError UNSUPPORTED_FORMAT_VERSION` | 없음 |
| DC-06 | magic·버전 | 모든 페이지 공통 헤더(16B) 뒤, Page 0 offset 16에 magic `4D 49 4E 49 44 42 00 00`("MINIDB\0\0"). `formatVersion` = 1(u16). WAL 버전 = 1 | magic 불일치 → `NOT_A_DATABASE`, 버전 ≠ 1 → `UNSUPPORTED_FORMAT_VERSION` | 없음 |
| DC-07 | 헤더 필드 | D.2 표가 전부(pageCount, freelistHead, freelistCount, catalogRoot, dbId) | catalogRoot는 항상 1 | 없음 |
| DC-08 | 페이지 체크섬 | CRC-32/IEEE(반사 다항식 0xEDB88320, init 0xFFFFFFFF, final xor 0xFFFFFFFF), 페이지 전체 4096바이트를 CRC 필드(offset 4..8)를 0으로 간주하고 계산. **모든 물리 읽기**(데이터 파일·WAL)에서 검증 | `crc32("123456789") = 0xCBF43926` | 없음 |
| DC-09 | 페이지 ID | u32. Page 0 = 파일 헤더. 포인터 값 0 = "없음"(Page 0은 어떤 구조의 자식도 아니므로 안전) | 최대 페이지 수 2^32−1 | 없음 |
| DC-64 | DB 식별자 | 생성 시 8바이트 `dbId`를 헤더와 WAL 헤더에 기록. 커밋 프레임이 있는 WAL의 dbId가 다르면 `CorruptionError WAL_MISMATCH` | 커밋 프레임이 없으면 WAL을 리셋하고 계속 | 없음 |
| DC-68 | 카탈로그 표현 | Page 1에서 시작하는 시스템 힙 `mdb_catalog`에 테이블 행·컬럼 행·인덱스 행을 공용 행 코덱으로 저장(D.7) | 사용자는 `mdb_catalog`를 질의할 수 없음 | 없음 |
