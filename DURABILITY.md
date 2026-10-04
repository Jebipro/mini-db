# Mini DB — DURABILITY

Pager·WAL 프로토콜, fsync 지점(F1~F5), 크래시 관찰표, 불변식(I1~I16, D1~D7), 실패 상태, 힙·B+tree·DML 절차.

> 출처: `DESIGN_REVIEW.md` rev1의 해당 섹션을 그대로 옮겼다(섹션 번호 유지). 변경은 `DECISIONS.md`에 기록한 뒤 두 문서를 함께 고친다.

## G.1 Pager 상태

| 상태 | 내용 |
|---|---|
| `frames` | `Map<PageId, { data: Uint8Array(4096), pins: number, dirty: boolean }>` + LRU 순서(접근 시 맨 뒤로) |
| Page 0 | 항상 상주: 오픈 후 close까지 프레임이 **절대 제거되지 않는다**(축출·롤백 모두. 롤백은 G.5의 이미지 복원). pin 합계에 포함 안 함 |
| `txn` | `active`, `dirty: Set<PageId>`, `headerBefore: Uint8Array \| null`(이 트랜잭션에서 Page 0을 처음 `markDirty`하기 직전의 이미지 = 마지막 커밋 이미지) |
| `stmt` | `active`, `savepoint: Map<PageId, Uint8Array \| null>` |
| `wal` | `index: Map<PageId, frameNo>`, `frames: number`, `lastChecksum`, `salt1`, `salt2`, `checkpointSeq`, `dbId` |
| `checkpointDue` | boolean |
| `state` | `open` / `failed` / `closed` |

## G.2 읽기 (`pin(id)`)

1. `state ≠ open` → `DB_FAILED` / `DB_CLOSED`. `id ≥ pageCount` → `CorruptionError PAGE_OUT_OF_RANGE`.
2. 프레임이 있으면 pins+1, LRU 갱신, `cache.hits++`, 반환.
3. `cache.misses++`. 빈 프레임 확보: 프레임 수 < cachePages면 새로 만듦. 아니면 LRU 앞에서부터 `dirty = false ∧ pins = 0 ∧ id ≠ 0`인 첫 프레임을 축출(`evictions++`, 쓰기 없음). 없으면 `LimitError TXN_TOO_LARGE`(DC-16 덕분에 정상 경로에서는 발생하지 않음).
4. `wal.index`에 있으면 WAL 프레임 `48 + 4120·n + 24`에서 4096바이트 읽기(`walFrameReads++`), 아니면 데이터 파일 `id × 4096`에서 읽기(`dataPageReads++`). 읽은 바이트 < 4096 → `PAGE_OUT_OF_RANGE`.
5. 검증: CRC → pageId → pageType(D.1). 실패 → `CorruptionError` → FAILED.
6. 프레임 등록(clean), pins = 1, 반환.

`unpin(ref)`: pins−1, 0 미만 → `InternalError`.

## G.3 수정 (`markDirty`, `allocate`, `free`)

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

## G.4 커밋 (`commitTxn`)

1. `txn.dirty`가 비어 있으면: 트랜잭션 종료만(쓰기·fsync 없음).
2. dirty 페이지를 pageId 오름차순으로 정렬. 각 페이지에 pageId 필드 확인 후 페이지 CRC 계산·기록.
3. 각 페이지 i에 대해 프레임 헤더(pageId, flags = 마지막이면 COMMIT, salt1, salt2, checksum 체인)를 만들고 **프레임 하나를 write 1회로** `48 + 4120·(wal.frames + i)`에 쓴다(`walFrameWrites++`).
4. **fsync(wal)** — **F4, 커밋 지점.**
5. 메모리 반영: `wal.index`에 각 페이지 → 프레임 번호, `wal.frames += n`, `lastChecksum` 갱신, dirty 프레임 → clean, `txn.dirty`/`savepoint` 비움, `txn.headerBefore = null`, `commits++`.
6. `walAutoCheckpointFrames > 0 ∧ wal.frames ≥ walAutoCheckpointFrames` → `checkpointDue = true`.
7. 3~4단계의 오류(I/O, CRC 계산 중 불변식 위반 등) → `StorageError IO_COMMIT_UNKNOWN`(결과 불명: 재오픈 후 적용됐을 수도 있음) + FAILED.

## G.5 롤백

- **문장 롤백** `rollbackStatement()`: `totalPins() ≠ 0` → `InternalError`. savepoint의 각 (id, img): `img ≠ null`이면 프레임 데이터에 복원(여전히 txn dirty). `img = null`이면 `id ≠ 0`은 프레임을 캐시에서 제거하고 `txn.dirty.delete(id)`, `id = 0`은 **프레임을 제거하지 않고** `txn.headerBefore`를 프레임 데이터에 복사, `frame.dirty = false`, `txn.dirty.delete(0)`, `txn.headerBefore = null`. savepoint 비움, `statementRollbacks++`. 엔진은 카탈로그 캐시 무효화.
- **트랜잭션 롤백** `rollbackTxn()`: `totalPins() ≠ 0` → `InternalError`. `txn.dirty`의 Page 0 외 프레임은 전부 제거. `txn.dirty`에 0이 있으면 Page 0 프레임은 남기고 `txn.headerBefore`를 데이터에 복사, `frame.dirty = false`. 집합 비움, `txn.headerBefore = null`, savepoint 비움, `rollbacks++`. 엔진은 카탈로그 캐시 무효화.
- Page 0 복원 결과는 제거 후 다시 읽은 것과 바이트 단위로 같다(`headerBefore`는 트랜잭션 시작 시 clean이던 마지막 커밋 이미지, I14). 따라서 "항상 상주"와 "롤백 = 마지막 커밋 상태"가 함께 성립한다.
- 둘 다 I/O가 없으므로 실패하지 않는다. 디스크에는 미커밋 데이터가 없다(no-steal).
- `releaseStatement()`: savepoint 비움(변경은 트랜잭션에 남음). `totalPins() ≠ 0` → `InternalError`.

## G.6 Checkpoint (`checkpoint()`)

전제: `state = open`, `txn.active = false`(아니면 `TransactionError TXN_ACTIVE`). `wal.frames = 0`이면 `checkpointDue = false`로 하고 종료.

1. `wal.index`의 pageId 오름차순으로: 이미지 = clean 캐시 프레임이 있으면 그것, 없으면 WAL 프레임에서 읽어 CRC 검증. 데이터 파일 `id × 4096`에 write 1회(`dataPageWrites++`).
2. **fsync(data)** — **F5.**
3. WAL 리셋(G.7의 `walReset`): truncate(0) → **fsync(wal) F2** → 새 헤더 write → **fsync(wal) F3**.
4. `wal.index` 비움, `wal.frames = 0`, `lastChecksum = 새 headerCrc`, `checkpointDue = false`, `checkpoints++`.
5. 1~3단계 오류 → `StorageError IO_ERROR` + FAILED.

## G.7 오픈·생성·복구 (`Pager.open`)

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

## G.8 닫기 (`close`)

1. `closed`면 반환. 2. `open`이고 `txn.active`면 `rollbackTxn`. 3. `open`이면 `checkpoint()`(실패 시 오류를 throw하되 파일 닫기·락 해제는 `finally`로 수행). 4. 파일 close, 락 해제, `state = closed`.

## G.9 fsync 지점과 크래시 관찰표

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

## G.10 불변식

구조 불변식(`integrityCheck`가 검사, 위반 시 이슈 코드):

| ID | 불변식 | 이슈 코드 |
|---|---|---|
| I1 | Page 0: magic·버전·pageSize·CRC 유효, `catalogRoot = 1`, `pageCount ≥ 2`. **WAL이 비어 있으면** 데이터 파일 크기 = pageCount×4096. WAL에 커밋 이미지가 남아 있으면 크기 조건 없음: checkpoint 전에 새로 할당·커밋된 페이지는 WAL에만 있으므로 데이터 파일이 pageCount×4096보다 작을 수 있다(정상, DEC-007) | `HEADER_INVALID`, `FILE_SIZE_MISMATCH` |
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

## G.11 실패 상태 정책

| 사건 | 분류 | 결과 |
|---|---|---|
| 읽기 I/O 오류 | `StorageError IO_ERROR` | 문장 롤백, 핸들 사용 가능 |
| 커밋 중 write/fsync 오류 | `StorageError IO_COMMIT_UNKNOWN` | FAILED. 재오픈하면 S 또는 S⁺ |
| checkpoint/WAL 리셋 중 오류 | `StorageError IO_ERROR` | FAILED. 재오픈하면 S |
| 체크섬·포맷 불일치 | `CorruptionError *` | FAILED |
| 불변식 위반, 비-MiniDb 예외 | `InternalError INVARIANT_VIOLATION` | FAILED |
| FAILED 이후 호출 | `StorageError DB_FAILED`(`cause` = 최초 오류) | `close()`만 허용(쓰기 없이 닫음) |

FAILED에서 재시도·자동 재오픈을 하지 않는다. 사용자는 `close()` 후 `Database.open()`으로 복구를 수행한다.

## G.12 Heap 절차

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

## G.13 B+tree 절차

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

## G.14 DML·DDL 실행 절차

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

## G.15 잠금 절차 (`acquireLock`)

1. 정규화된 절대 경로가 모듈 레지스트리에 있으면 `DB_LOCKED`.
2. `<db>-lock`을 `wx`로 생성 → 성공 시 `${process.pid}\n` 쓰고 닫기(fsync 없음) → 레지스트리 등록.
3. `EEXIST`: 내용 읽기 → `^\d+\n?$`가 아니면 `DB_LOCKED`. pid = 현재 PID → `DB_LOCKED`. `process.kill(pid, 0)`이 성공 또는 `EPERM` → `DB_LOCKED`. `ESRCH` → 락 파일 삭제 후 2를 **1회만** 재시도, 또 실패하면 `DB_LOCKED`.
4. 해제: 레지스트리 제거, 락 파일 삭제(오류 무시).
5. `MemoryVfs`는 같은 의미를 메모리 집합으로 구현(PID 검사 없음).
6. 한계(리뷰 L-2, DEC-007): 3의 "읽기 → 삭제 → 재생성"은 원자적이지 않다. 두 프로세스가 같은 stale 락을 동시에 발견하면, 한쪽이 새로 만든 락을 다른 쪽이 stale로 알고 삭제할 수 있어 둘 다 락을 얻는다. v1의 보장 범위는 단일 프로세스(같은 프로세스 이중 오픈은 레지스트리로 차단) + 협력적 잠금이다.

### 캐시·버퍼·트랜잭션

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

### WAL·복구

| ID | 영역 | 확정 규칙 | 예시·경계 | 번복 조건 |
|---|---|---|---|---|
| DC-18 | WAL 형식 | 헤더 48B + 프레임(헤더 24B + 페이지 4096B = 4120B). 프레임은 트랜잭션의 dirty 페이지를 pageId 오름차순으로, 마지막 프레임에 COMMIT 플래그. 체크섬 체인: `ck_k = CRC32(LE32(ck_{k−1}) ‖ frameHdr[0..16) ‖ page)`, `ck_{−1}` = 헤더 CRC. 프레임마다 헤더의 salt1/salt2 복사. **프레임 1개 = write 호출 1회** | 프레임 k 오프셋 = 48 + 4120·k | 없음 |
| DC-19 | 복구 중단 규칙 | 앞에서부터 스캔하며 다음 중 하나면 **중단**: 남은 바이트 < 4120, salt 불일치, 체크섬 불일치, 예약 필드/플래그 비정상. 마지막 COMMIT 프레임까지만 인정. 체인은 유효한데 페이지 CRC가 틀리면 `CorruptionError WAL_FRAME_INVALID` | 중간 비트 플립 = 그 지점 이후 폐기(크래시 꼬리와 구분 불가, LIMITATIONS) | 없음 |
| DC-20 | 읽기 경로 | dirty/clean 캐시 → WAL index(`pageId → 최신 커밋 프레임`) → 데이터 파일 | WAL에서 읽은 페이지도 CRC 검증 | C.1.1 번복 시 |
| DC-21 | checkpoint 순서 | WAL index의 각 페이지를 pageId 오름차순으로 데이터 파일에 쓰기 → **fsync(data) [F5]** → WAL truncate(0) → **fsync(wal) [F2]** → 새 헤더(seq+1, 새 salt) 쓰기 → **fsync(wal) [F3]** → WAL index 비움 | fsync 3회 | 없음 |
| DC-22 | WAL 파일 수명 | WAL 파일은 삭제하지 않는다. 리셋 = truncate + 헤더. 헤더 무효 ∧ 파일 크기 ≤ 48 → 빈 WAL. 헤더 무효 ∧ 크기 > 48 → `CorruptionError WAL_HEADER_INVALID` | 생성 직후 WAL 크기 = 48 | 없음 |
| DC-63 | 파일 생성 | 새 DB 생성은 bootstrap 트랜잭션: 파일 생성 → 디렉터리 fsync(F1) → WAL 리셋 → Page 0(헤더)·Page 1(카탈로그 head) 커밋(F4) → checkpoint. 데이터 파일 크기 0 ∧ 커밋 프레임 없음 = "새 DB" | 생성 중 어느 지점 크래시든 재오픈 성공 | 없음 |
| DC-65 | 난수 | dbId·salt는 옵션 `entropy: (n) => Uint8Array`(기본 `crypto.randomBytes`). 테스트는 seed PRNG 주입 | 같은 entropy·같은 연산 → 바이트 단위 동일 파일 | 없음 |

### RID·인덱스

| ID | 영역 | 확정 규칙 | 예시·경계 | 번복 조건 |
|---|---|---|---|---|
| DC-27 | RID 안정성 | RID = (pageId u32, slotId u16). 같은 페이지 안 재배치·compaction은 RID 유지. 다른 페이지로 이동하면 새 RID이며 그 행의 **모든 인덱스 항목을 갱신**. 같은 RID면 값이 바뀐 컬럼의 인덱스만 갱신 | tombstone slot 재사용 가능(가장 낮은 번호) | 없음 |
| DC-28 | 인덱스 항목 | 항목 = (key 바이트, rid). 비교기 하나: `compareEntry(a,b) = compareBytes(a.key,b.key)`(사전식, 접두사가 작음) 후, **비유일 인덱스만** rid(pageId, slot) 비교. **NULL 값은 색인하지 않음** | 유일 인덱스는 같은 키 2개 불가 | 없음 |
| DC-29 | 루트 고정 | 인덱스 루트 페이지 ID는 생성부터 DROP까지 불변. 루트 분할 시 내용을 새 페이지 L, R로 옮기고 루트를 내부 노드로 재초기화 | 카탈로그는 DDL에서만 변경 | 없음 |
| DC-30 | 삭제 | lazy: 리프 항목만 제거, separator·빈 리프 유지 | C.1.4 | C.1.4 |
| DC-70 | 플래너 인덱스 사용 | 인덱스는 후보 행 축소에만 사용. **WHERE 전체를 Filter로 유지**(재검사). ORDER BY에 인덱스 순서 사용 안 함 | F.8 | 없음 |

### 실패·잠금·플랫폼

| ID | 영역 | 확정 규칙 | 예시·경계 | 번복 조건 |
|---|---|---|---|---|
| DC-49 | FAILED 상태 | 진입 조건: (a) 커밋·checkpoint·복구·WAL 리셋 중 write/sync/truncate 오류, (b) `CorruptionError` 발생, (c) `InternalError` 발생. 이후 데이터에 접근하는 모든 호출(`execute`, `executeScript`, `schema`, `integrityCheck`, `checkpoint`) → `StorageError DB_FAILED`(원인을 `cause`로). 예외: `close()`와 읽기 전용 진단 접근(`state`, `inTransaction`, `stats()`, `resetStats()` — 메모리 카운터만 읽거나 0으로 되돌림)은 허용(DEC-007). 재시도 없음. 공개 API 인수 오용(`UsageError`)은 FAILED로 만들지 않음(T-ERR-004) | fsync 실패 후 재시도는 성공으로 보여도 신뢰할 수 없음(일반적으로 알려진 문제) | salvage 모드 요구 시 |
| DC-50 | 읽기 오류 | 데이터 파일/WAL **읽기** I/O 오류 → `StorageError IO_ERROR`, 문장 롤백, 핸들 사용 가능 | | 없음 |
| DC-51 | 예기치 않은 예외 | `Database` 공개 메서드는 `MiniDbError`가 아닌 예외를 `InternalError INVARIANT_VIOLATION`(원인 보존)으로 감싸고 FAILED | 테스트 하네스의 `SimulatedCrash`는 예외(그대로 전파). 사용자 코드인 `executeScript`의 `onResult` callback이 던진 예외도 예외: 감싸지 않고 그대로 전파하며 FAILED로 만들지 않음(DEC-008) | 없음 |
| DC-52 | 락 파일 | `<db>-lock`을 배타 생성(`wx`)하고 `pid\n` 기록. 이미 있으면 PID 읽기: 파싱 불가 → 잠김. 같은 PID 또는 `process.kill(pid, 0)` 성공/EPERM → 잠김(`StorageError DB_LOCKED`). ESRCH → stale로 보고 삭제 후 1회 재시도. 같은 프로세스 이중 오픈은 정규화된 경로의 모듈 레지스트리로 먼저 차단. close 시 삭제(삭제 실패는 무시) | 협력적 잠금일 뿐 OS 잠금 아님. stale 인수(읽기 → 삭제 → 재생성)는 원자적이지 않아, 두 프로세스가 동시에 같은 stale 락을 인수하면 둘 다 락을 얻을 수 있다(리뷰 L-2, v1은 단일 프로세스·협력적 잠금 범위, LIMITATIONS) | 다중 프로세스 지원 시(FUTURE) |
| DC-53 | 디렉터리 fsync | 데이터/WAL 파일을 **새로 만든 경우**에만 부모 디렉터리 fsync(F1). POSIX: 실패가 EINVAL/ENOTSUP/EISDIR면 미지원으로 기록하고 계속, 그 외 오류 → `StorageError IO_ERROR`. Windows: 디렉터리 fsync를 수행하지 않음(Node로 디렉터리 핸들 fsync 불가), `stats.io.dirSyncs` 0 | WAL 리셋은 truncate라 디렉터리 변경 없음 | 없음 |
| DC-69 | 줄바꿈 | `.gitattributes`: `*.sql`, `*.expected`, `*.md`, `*.ts` → `eol=lf`. 렉서는 `\r`을 공백 취급. 골든 비교 전 CRLF→LF 정규화 | | 없음 |

## 구현 반영

- fsync 코드 위치: F1 `src/storage/pager.ts`(open), F2·F3 `src/storage/wal.ts`(`WalFile.reset`), F4 `src/storage/wal.ts`(`appendTxn`), F5 `src/storage/pager.ts`(`checkpoint`, `recoverOrCreate`). 각 줄에 `// FSYNC-Fn` 태그.
- I15는 `Pager.pin`의 WAL 경로 assertion으로 구현(P15).
- 독립 리뷰(CLAUDE_INDEPENDENT_REVIEW.md) 후속 문서 정정(DEC-007): I1 크기 조건은 WAL이 빈 경우에만, DC-49의 FAILED 예외(진단 접근) 명시, DC-52 stale 락 인수의 다중 프로세스 경쟁 한계 명시.
- 복구 중 재크래시 검증: T-CRASH-P02/T-CRASH-002(P-DURABLE·P-ALL) + T-CRASH-006(P-TORN·P-RANDOM·이중 크래시).
