# CLAUDE_INDEPENDENT_REVIEW — Mini DB post-implementation adversarial review

- Date: 2026-10-04
- Commit reviewed: `b58d809` (tag `phase-17-done`, `main`, clean working tree at start)
- Scope: Core (P0–P17). Stretch items in FUTURE.md (aggregates, GROUP BY, JOIN, composite indexes, REAL, …) are out of scope.
- Rule for this pass: **no production code was changed.** Only review tests (`tests/review/`), a review-only Vitest config (`vitest.review.config.ts`), and this report were added. Every mutation in §18 was applied temporarily and restored with `git checkout`, then checked with `git diff -- src` (clean after each run).
- Source of truth: the code and the behaviour I re-ran myself. Numbers from PROGRESS.md and REVIEW_PACKET.md were not trusted; only numbers re-measured in this session are reported.

---

## 1. Executive Summary

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 2 |
| Test Gap | 6 |
| Documentation Gap | 5 |
| Design Note | 5 |

The four review questions:

1. **Do the atomicity/durability/integrity/recovery claims hold in the code?**
   - **Yes, within the stated fault model.**
   - I traced F1–F5 and the commit/checkpoint/recovery order line by line, and the code matches DURABILITY G.4–G.7 exactly.
   - I added a stronger recovery re-crash suite: torn writes and random subsets during recovery, plus double crashes. It ran 5,068 recovery crashes and 714 double crashes without a single divergence.
2. **Do SQL, heap and index match the spec?**
   - **Yes.** I wrote an independent B+tree model test (height 3: leaf, internal and root splits, prefix keys, empty key, 512-byte keys, lazy delete, rollback).
   - I wrote a row-move-heavy SQL model test with four indexes.
   - I wrote boundary tests: 4060/4061-byte rows, 4000/4001-byte TEXT, 512/513-byte keys, emoji.
   - All agree with independent models.
   - The one plan-dependent behaviour I reproduced (a WHERE overflow errors under SeqScan but not under IndexScan) is **explicitly allowed by DC-43**, so it is a Design Note, not a bug.
3. **Do the existing tests verify these guarantees?**
   - **Mostly yes.** 10 of 11 new mutations were caught by `npm run check` alone, including the F2 removal and the recovery F5 removal.
   - **One survivor:** I11 in `integrityCheck` can be weakened to count-only and nothing fails (TG-1). The new test REVIEW-INT-001 kills that mutant.
4. **Are there real bugs or high-value gaps?**
   - No correctness or durability bug was found.
   - The real defects are minor: an API-misuse path puts the handle in FAILED (L-1), and a stale-lock takeover race (L-2, by reading the code only).
   - The rest are test-coverage gaps and doc wording.

---

## 2. Environment / Baseline

| Item | Value |
|---|---|
| OS | Windows 11 Pro 10.0.26200 |
| Node / npm | v24.16.0 / 11.13.0 (primary); **v20.20.2** (found already installed via nvm-windows; no install needed) |
| Git | `main`, HEAD `b58d809`, 18 commits, tags `phase-00-done` … `phase-17-done`; clean tree at start |
| Scripts | `build typecheck check:any check:docs test test:random test:crash check cli bench` |

Results measured in this session:

| Run | Node 24 | Node 20 |
|---|---|---|
| `npm run check` (typecheck + check:any + check:docs + 33 files / 165 tests) | pass (7.9 s) | pass (same steps run directly with Node 20) |
| `npm run test:random` (defaults: 200 + 200 + 50 seeds × 1000 steps) | pass (3/3, 54 s) | pass (3/3) |
| `npm run test:crash` (full matrix) | pass (5/5, 22 s) | pass (5/5) |
| Strengthened `test:random` `SEEDS=600` (600 + 600 + 600 seeds × 1000 steps) | pass (3/3, 209 s) | — |
| Strengthened `T-CRASH-005` `SEEDS=300` (300 random workloads × 5 random crash points/policies) | pass (25.6 s) | — |
| Review suite `tests/review` (10 files, 29 tests, default seeds) | 25 pass + 4 intended fail-first (REVIEW-API-001) | 25/25 pass (api-misuse excluded) |
| Review B+tree / row-move tests at `REVIEW_SEEDS=150` | pass (150 + 150 B+tree seeds × 3,000 ops; 150 row-move seeds × 600 statements; 78 s) | — |

`check:docs` reports: 56 error codes, 153/153 test IDs, fsync tags F1–F5.

Running the review tests:

```bash
npx vitest run --config vitest.review.config.ts
```

---

## 3. Critical Findings

None.

## 4. High Findings

None.

## 5. Medium Findings

None.

## 6. Low Findings

### L-1 — Wrong argument types fail the handle (InternalError + FAILED) instead of UsageError

- **Reproduction (fail-first):** `tests/review/api-misuse.review.test.ts`. It fails today on all 4 cases.
- **Minimal reproduction** (from JavaScript, or TypeScript with a cast):
  ```ts
  db.execute(undefined)                          // or execute(42), execute(sql, null), executeScript(null)
  ```
- **Expected:**
  - SPEC H.2 describes UsageError as API misuse (`INVALID_OPTION`).
  - DC-49/DC-51 reserve FAILED for storage failures, corruption and engine bugs.
  - So the call should throw `UsageError` and the handle should stay `open`.
- **Actual:** `InternalError INVARIANT_VIOLATION` ("unexpected error: Cannot read properties of undefined…"), and `db.state === 'failed'`.
- **Root cause:**
  - `Database.execute` / `executeScript` (`src/engine/database.ts:112-144`) pass the arguments straight to `tokenize`.
  - `opts.forceSeqScan` is read on a `null` `opts`.
  - The resulting `TypeError` is a non-MiniDb error, so `wrap()` (l.93) converts it to InternalError and calls `markFailed`.
- **Impact:**
  - Untyped callers only.
  - No data corruption: FAILED blocks writes, and committed data is intact after reopen.
  - An open explicit transaction is lost, and the handle must be closed and reopened.
  - The CLI always passes strings, so it is not affected.
- **Why the tests missed it:** no test calls the public API with ill-typed arguments; the TypeScript types hide it.
- **Fix direction:** validate `typeof sql === 'string'` and that `opts` is an object or undefined at the top of `execute`/`executeScript`, and throw `UsageError INVALID_OPTION` before `guard`'s failure path.

### L-2 — Stale-lock takeover is not atomic (two processes can both "recover" a stale lock)

- **Status:** found by reading the code only; **not reproduced** (it needs two racing processes).
- **Where:** `NodeVfs.acquireLock` (`src/storage/node-vfs.ts:139-190`, unlink at l.173).
- **Mechanism:** when the lock file exists with a dead PID, the sequence is: read the PID → check whether the process is alive → `unlinkSync(lockPath)` → `tryCreate()`. Two processes A and B can race like this:
  1. Both read the dead PID.
  2. A unlinks the lock and creates its own.
  3. B unlinks **A's new lock** and creates its own.
  4. Both now believe they hold the lock.
- **Impact:**
  - Concurrent writers to one database, which can corrupt it.
  - It only happens after a crash leaves a stale lock **and** two processes open the database at the same moment.
  - Multi-process access is an accepted, documented limitation ("lock file is cooperative", REVIEW_PACKET §7). It is listed here because the stale-lock path actively *removes* a lock it did not verify.
- **Fix direction:**
  - Re-read the lock and compare it before unlinking (still racy), or
  - Replace the unlink+create with an atomic rename-based takeover (create a temp file, then rename over the stale lock, then re-read it to confirm the PID), or
  - Document that the stale-lock recovery is single-process-safe only.

---

## 7. Test Gaps

| ID | Gap | Evidence | Status |
|---|---|---|---|
| TG-1 | I11 (index ↔ heap) is only tested by *deleting* an entry, which also changes the count. A count-only I11 passes the whole suite. | Mutation M11 survived `npm run check`. | Closed by `REVIEW-INT-001` (same count, dangling RID; same count, wrong PK key; also I3 `PAGE_MULTI_OWNED`). It passes on current code and kills M11. |
| TG-2 | Re-crashing during recovery (T-CRASH-P02 and CW6/T-CRASH-002) is tested only under P-DURABLE and P-ALL, never with torn writes or random subsets during recovery, and never as a double crash. | `tests/long/crash.long.test.ts:33-67, 81-109` | Covered by `REVIEW-CR-001`: 5,068 torn/random recovery crashes and 714 double crashes on CW3/CW4/CW5 plus 2 random workloads, all converging. |
| TG-3 | The fault model tears writes only as a **prefix** (P-TORN, and P-RANDOM on 512-byte sectors). Out-of-order sector persistence inside one write, misdirected writes and phantom writes are not modelled. | `src/storage/memory-vfs.ts:203-218` | Open. By reasoning, the design tolerates it: WAL frames carry a full-frame checksum chain, and data pages are rewritten from the WAL until F5. But it is not demonstrated. |
| TG-4 | The random generator and reference model never reach `ROW_TOO_LARGE`/`TEXT_TOO_LARGE`; the PK is always `c0 INTEGER` (never TEXT/BOOLEAN PK); WHERE never contains arithmetic (deliberate, DC-43). | `tests/model/generator.ts:77-87`, `ref-model.ts` (no size prediction) | Open (unit and golden tests cover the limits). `REVIEW-BND-001` adds SQL-level 4060/4061, 4000/4001, 512/513 and emoji boundaries. |
| TG-5 | Random SQL tests seldom build B+trees deeper than 2 levels (8-byte keys fit about 250 per leaf). Internal splits and root splits of internal nodes come mainly from unit tests. | Measured with my model test: before forcing large keys, max height was 2. | Covered by `REVIEW-BT-001`: an independent model, height 3, 80 seeds × 3,000 ops by default. |
| TG-6 | Crash tests use `deterministicEntropy(seed)`, which restarts on every open, so WAL salts repeat across generations. The salt and chain-seed defence against stale frames is never exercised. That is moot today, because truncate is made durable by F2 before a new header, but a regression in F2 would only be caught by the protocol-trace tests and T-WAL-003/004 (see M3). | `tests/support/sql-crash.ts:125-127` | Open (low value). |

The previously missed row-move mutation is now covered by three independent places: the short model test, T-IDX-002, and REVIEW-RM-001. See M8.

---

## 8. Documentation Gaps

| ID | Where | Claim | Reality |
|---|---|---|---|
| DG-1 | DURABILITY.md G.10 **I1** | "data file size ≥ pageCount×4096 (= when the WAL is empty)" | With committed but not-yet-checkpointed new pages, the data file is legitimately **smaller** than pageCount×4096. The code correctly checks only equality, and only with an empty WAL (`src/engine/integrity.ts:62`). Reproduced in `REVIEW-DOC-001`. The doc should drop the "≥" clause or qualify it. |
| DG-2 | DURABILITY.md DC-49 | "이후 `close()`를 제외한 모든 호출 → `StorageError DB_FAILED`" | `stats()`, `resetStats()`, `state` and `inTransaction` work in FAILED (and `stats()` also works after close). This is harmless (read-only counters), but the wording is absolute. Reproduced in `REVIEW-ERR-001`. |
| DG-3 | DECISIONS.md **DEC-006** rationale | That a SELECT erroring or succeeding depending on whether an index exists "violates DC-70 / T-DIFF-001". | DC-43 explicitly allows plan-dependent runtime errors from row evaluation (reproduced in `REVIEW-SQL-001`, last case). DEC-006 is right for *planner-raised* errors (encoding a literal), but its rationale reads as a general plan-independence guarantee. Clarify: "no plan-dependent errors raised by the planner itself; row-evaluation errors follow DC-43." |
| DG-4 | REVIEW_PACKET.md §1 "Detection" | "any bit flip in a page is detected (CRC32 per page)" | It is true for data-file and WAL page images that are read. A bit flip in the middle of the WAL silently truncates history (stated in §8 of the same document). A flipped data-file page that has a newer WAL image is overwritten at checkpoint without being reported. §1 should cross-reference §8. |
| DG-5 | LIMITATIONS.md, REVIEW_PACKET §7 | "Node 20 … was not run" | Accurate at the time of writing. **This review ran `check`, `test:random`, `test:crash` and the review suite on Node v20.20.2, and all passed.** Update when the review is accepted. |

Verified accurate:

- README's crash-safety wording ("verified against a simulated file system, not real power loss").
- REVIEW_PACKET §4 fsync file:line table:
  - F1 `pager.ts:136`
  - F2 `wal.ts:196`
  - F3 `wal.ts:206`
  - F4 `wal.ts:231`
  - F5 `pager.ts:629` and `:175`
- All §9 line references.

---

## 9. Storage / Pager Audit

Each call path was traced in `src/storage/pager.ts`, `page.ts`, `file-header.ts` and `layout.ts`.

- **Page layout and CRC.**
  - `computePageCrc` covers all 4096 bytes with [4,8) taken as zero.
  - `verifyPage` checks, in order: CRC → stored id = position → known type.
  - Page 0 additionally checks magic, version, page size and HEADER type, with `pageCount ≥ 1` (`parseHeaderPage`).
  - CRC is stamped only at commit (`commitTxn` l.579). Cache frames are therefore unstamped while dirty, which is correct because they are never written to disk while dirty.
- **Allocation, free and freelist.**
  - `allocate` dirties page 0 before touching the freelist head and verifies the head is FREE.
  - A `TXN_TOO_LARGE` during allocation removes the half-made frame (l.419-421).
  - `free` re-initialises the page as FREE and pushes it onto the list.
  - `freelistPages` detects cycles, out-of-range ids, wrong types and count mismatches.
- **LRU, pins and no-steal.**
  - Map insertion order is the LRU; a hit moves the frame to the end (page 0 excluded).
  - The eviction victim is the first frame that is not page 0, not dirty and not pinned.
  - Dirty frames are never evicted, and the dirty limit is `cachePages − 32`, so a reader always finds a victim unless pins are leaked; I13 guards against leaked pins.
- **Read path.**
  - `pin` reads cache → `walIndex` (I15 frame-bound assertion) → data file.
  - A short read becomes `PAGE_OUT_OF_RANGE`, and every physical read is verified.
  - `pin` on an id ≥ pageCount becomes `PAGE_OUT_OF_RANGE` CorruptionError, which fails the handle.
  - I looked for a legitimate path that reads an id < pageCount that is neither cached, in the WAL, nor in the file. None exists: pages allocated in a transaction stay dirty; after a rollback page 0 and pageCount are restored; after commit the page is in the WAL.
- **Page 0 resident semantics (rev1), verified byte-exact in `REVIEW-P0-001`.** Each case checks the private `headerBefore`, `txnDirty`, `frame.dirty` and the savepoint.

| Path | Page 0 bytes after | dirty | in txnDirty | headerBefore |
|---|---|---|---|---|
| Autocommit success | stamped, equal to its WAL image | no | no | null |
| Autocommit failure after dirtying page 0 (`CREATE UNIQUE INDEX` on duplicates) | identical to the pre-statement image | no | no | null |
| Explicit txn; S1 dirtied page 0; S2 dirties it again and fails | identical to the post-S1 image | yes | yes | pre-transaction image |
| Explicit txn; S2 is first to dirty page 0 and fails | identical to the pre-transaction image | no | no | null; correctly re-captured by S3 |
| ROLLBACK | pre-transaction image | no | no | null |
| COMMIT | stamped | no | no | null |

  - Page 0 is never evicted (`makeRoom` skips id 0), never deleted by rollback, and is re-read and verified at every open.
  - `headerBefore` is captured at the first `markDirty(0)` of the transaction, *after* the TXN_TOO_LARGE check, so a refused markDirty leaves no state behind.
- **Minor observations** (no finding):
  - I14's "page 0 frame always exists" is enforced only implicitly: the `header0()` cast would throw a TypeError, which becomes an InternalError.
  - I15's "pageId < pageCount" is not asserted at runtime; only the frame bound is.

## 10. WAL / Durability / Recovery Audit

**Order checked line by line:**

- **Commit:**
  1. `commitTxn` stamps every dirty page's CRC.
  2. `appendTxn` writes one frame per page in ascending order, with the COMMIT flag on the last frame and a checksum chain seeded by the header CRC.
  3. `fsync` (F4).
  4. Only then is `walIndex` updated and the frames marked clean.
  5. The API returns.
- **Checkpoint:**
  1. Write every `walIndex` page to the data file (cached clean frame or WAL image).
  2. F5.
  3. `truncate(0)`.
  4. F2.
  5. Write a new header with new salts and seq+1.
  6. F3.
  7. Any exception puts the handle in FAILED.
- **Recovery:**
  1. Read the WAL header.
  2. Scan to the last COMMIT frame of an unbroken chain.
  3. Check the dbId.
  4. Write the latest image of each page.
  5. F5.
  6. Read and verify the header and dbId.
  7. Reset the WAL (F2, F3) unless the WAL is exactly a valid 48-byte header with a matching dbId.
  8. Check FILE_TRUNCATED.
- **Bootstrap:**
  1. Reset the WAL.
  2. Bootstrap transaction (page 0 + catalog page 1).
  3. F4.
  4. Checkpoint.
- **D1–D7:** all hold as written. The trace regex `^D?TSWS(W+S|w+sTSWS)*$` (T-CRASH-004) enforces the per-op order on every workload.

**Crash windows** (✓ = observed state is the acked state, or acked + in-flight, with integrity ok):

| Window | Next open observes | Evidence |
|---|---|---|
| Partial WAL frame write (torn) | Chain breaks before COMMIT, so the transaction is dropped; previous commits intact | T-CRASH-001 P-TORN, T-WAL-004 ✓ |
| Just before / during / after the last COMMIT frame write, before F4 | P-DURABLE: dropped. P-ALL: complete frame + COMMIT, so the in-flight transaction is applied (allowed) | T-CRASH-001 ✓ |
| After F4, before the API returns | Durable; applied ✓ (`acked` or `inFlight`) | T-CRASH-001 ✓ |
| During checkpoint data writes | WAL intact, so a full replay overwrites torn or partial pages ✓ | T-CRASH-001, T-CORR ✓ |
| Before / after F5 | Before: replay. After: data durable, WAL intact until truncate | ✓ |
| Before / after truncate, before / after F2 | Data is durable already; the WAL is either replayed idempotently or empty | ✓ |
| During the new header write, before F3 | Truncate is durable (F2), so size ≤ 48 with an invalid header is treated as an empty WAL | ✓ (M3 shows this needs F2) |
| After F3 | Empty WAL with a new generation | ✓ |
| Recovery replay re-crash (any op, any policy, twice) | Converges to the single-recovery state | T-CRASH-P02, T-CRASH-002, **REVIEW-CR-001** (5,068 + 714) ✓ |
| Crash during bootstrap | A fresh, empty database (a new dbId if the data file was still empty) | T-CRASH-P03, CW1 ✓ |

**Invariants (independent judgement):**

- **Acked commits survive:** yes. Success is returned only after F4 (D1), and the crash oracle requires state ≥ acked for every crash case.
- **Uncommitted pages never reach the data file:**
  - Data-file writes exist only in `checkpoint` and `recoverOrCreate`.
  - Checkpoint refuses to run inside a transaction and asserts that no cached page is dirty.
  - Recovery writes only `committed` images.
  - Mutation M1 (applying the uncommitted tail) is caught.
- **Checkpoint makes data durable before touching the WAL:** yes (F5 before truncate; reversing them was a previous sanity mutation).
- **Recovery is idempotent:** it writes full images only and does not change the WAL before F5. Mutation M2 (recovery without F5) is caught by T-PGR-012.
- **The incomplete WAL tail is never applied:** yes (pending frames are committed only on a COMMIT flag; see M1).
- **IO_COMMIT_UNKNOWN:**
  - A WAL write or F4 failure becomes `StorageError IO_COMMIT_UNKNOWN`, the handle goes FAILED, and nothing more is written.
  - Reopen sees either state (S or S+) with integrity ok (re-checked in `REVIEW-ERR-001` under P-DURABLE and P-ALL).
  - Design note DN-4: any MiniDbError from `appendTxn`, including an `invariant` InternalError, is relabelled IO_COMMIT_UNKNOWN.
- **Auto-checkpoint failure** is reported by the *next* statement, never by the commit that made the checkpoint due (DC-26). Verified in `REVIEW-ERR-001`.

**Accepted limits (unchanged):**

- Real power loss was not tested.
- OS/disk caches may behave differently from the model.
- Windows directory fsync is a no-op (`syncDir` returns false), so F1 is not effective on this platform.
- Multi-process robustness is out of scope.

## 11. Heap / Record Audit

- **Row codec:**
  - Layout: u8 count, then a null bitmap LSB-first, then INTEGER i64 LE / BOOLEAN u8 / TEXT u16+UTF-8.
  - The decoder rejects: wrong count, unused bitmap bits, truncated fields, integers outside the safe range, BOOLEAN bytes > 1, invalid UTF-8, and trailing bytes.
  - Lone surrogates are rejected at lex time, so `encodeUtf8` never substitutes U+FFFD.
- **Slotted page:**
  - The `canInsert`/`canUpdate` space formulas are correct.
  - Compaction keeps slot numbers, so RIDs stay stable.
  - Tombstones are `(0,0)` and trailing tombstones are trimmed.
  - `fragmentedBytes = 4096 − recordStart − Σlive` holds after every operation (I6 checks it).
  - Growing an update in place compacts with the slot temporarily dead.
- **Row move:**
  - `HeapFile.update` deletes the record from the old page and inserts into the tail page or a new page.
  - When the tail page cannot fit the grown row after its own delete, it cannot fit it after the delete either: the trailing-slot trim gives back exactly the 4 bytes a new slot needs. So a moved row never lands back on its own page.
  - I looked for a RID being reused inside one statement. A moved row can only land in a tombstone of the *tail* page. A target that leaves the tail page makes a new page the tail, so tombstones created by this statement are never reused by it. Index maintenance deletes all old entries before inserting new ones in any case, which tolerates such reuse.
- **Boundaries** (`REVIEW-BND-001`):
  - Rows: 4060 bytes accepted; 4061 gives `ROW_TOO_LARGE` on both INSERT and UPDATE.
  - TEXT: 4000 bytes accepted (ASCII, 2-, 3- and 4-byte code points); 4001 gives `TEXT_TOO_LARGE`.
  - Empty TEXT stored and indexed.
  - 300 rows grown one by one to near the maximum (moves) and shrunk back, with an index: integrity ok, and index plan = seq plan.
- **Row-move random test** (`REVIEW-RM-001`): 30 seeds × 600 statements by default.
  - Pads grow and shrink between 0 and 3,000 bytes, and `id = id + k` shifts are mixed in.
  - Four indexes (non-unique TEXT, UNIQUE TEXT, INTEGER, BOOLEAN), explicit transactions with rollback, and reopen.
  - Every query also runs with `forceSeqScan`.
  - Result: no divergence. It kills the row-move maintenance mutant (M8).

## 12. B+tree / Index Audit

- **Key codec:** INTEGER is 8-byte big-endian with the sign bit flipped (order-preserving over ±(2^53−1)). BOOLEAN is 0/1. TEXT is raw UTF-8 bytes; `compareBytes` sorts a strict prefix first, so `a < aa < ab`. The empty key is the smallest.
- **Comparator:** a unique index compares the key only; a non-unique index compares (key, rid). Separators are full entries; routing uses "first separator > target" (`route`), and leaf search uses `lowerBound`.
  - Unique `findUnique` with the MIN_RID target lands in the only leaf that can hold the key.
  - Non-unique seeks start at (key, MIN_RID) and follow `rightPtr`.
- **Splits:**
  - Leaf: the separator is `entries[m]`, the right leaf takes `[m..]`, and the old `rightPtr` chain is kept.
  - Internal: `cells[m]` is promoted and its child becomes the left node's right pointer.
  - Root (fixed id, DC-29): content moves into two new children. Leaf and internal roots each use the correct page types.
  - `insertIntoParent` places `(sep, left)` before the pointer that reached `left` and re-points it at `right`. Correct, including the `rightPtr` case.
- **Lazy delete:** removes the exact (key, rid) and asserts it existed. Empty leaves stay; scans skip them with a hop limit of pageCount.
- **Ranges:** both bounds compare keys only; an exclusive lower bound skips equal keys across leaves; an upper bound stops scanning.
- **NULLs** are not indexed, and UNIQUE allows many NULLs (`REVIEW-SQL-001`).
- **Heap → index and index → heap:**
  - I11 compares the exact multiset of `(encodeKey(row[col]), rid)` (sorted string lists).
  - The new review tests check both directions with the entry count held constant.
- **Independent model** (`REVIEW-BT-001`, 40 + 40 seeds × 3,000 ops):
  - Mixes the empty key, prefix families, 300–512-byte keys, multibyte and NUL bytes, 8-byte integers.
  - Duplicates on non-unique trees; bulk deletes that empty leaves; random inclusive/exclusive/open ranges; `findUnique`.
  - 30% of transactions are rolled back, with occasional checkpoints. After every commit and rollback, `check()` must report no issues and the entries must equal the model.
  - Reached height 3 with up to 718 entries. No divergence.

## 13. SQL / Planner / Executor Audit

- **Lexer and analyzer:**
  - Identifiers are ASCII and lower-cased; keywords are case-insensitive; string escapes use `''`.
  - Strings are rejected for unpaired surrogates or > 4000 bytes; integer literals > 2^53−1 are rejected.
  - No implicit coercion: comparisons need equal types or NULL; arithmetic needs INTEGER; WHERE needs BOOLEAN or NULL.
- **Three-valued logic and short-circuit:**
  - Matches F.5 (truth tables, AND false-left and OR true-left short-circuit).
  - Arithmetic is range-checked per operation, and −0 is normalised.
  - Mutations M18 and M19 are caught.
- **ORDER BY:** NULL is smallest (first in ASC, last in DESC); the sort is stable.
- **LIMIT/OFFSET:** `LIMIT 0` does not open the child; edge cases verified.
- **UPDATE:**
  - Targets are materialised before any change (DC-62), so there is no Halloween problem. A 200-row growing UPDATE through an index on the updated column changes each row exactly once.
  - New rows are fully computed and checked (NOT NULL, size, key size) before any write.
  - Uniqueness is checked at statement level: duplicates among the new keys, plus an owner that is not a target. A shift (`id = id + 1`) and a sign swap succeed, and both collision kinds are rejected.
  - Index maintenance:
    - For every index whose column changed or whose row moved, all old entries are deleted before the new ones are inserted.
    - Indexes that were not touched and whose row did not move are left alone.
- **Planner:**
  - Sargable conjuncts are only `col op literal` or `-literal`, with flip normalisation; > 512-byte TEXT literals are excluded (DEC-006).
  - Index choice: unique `=` > non-unique `=` > range, ties broken by name.
  - Bounds: on ties, the exclusive bound wins. Contradictions give empty scans.
  - **The whole WHERE stays as a Filter** (DC-70). As a result, a planner bound error (e.g. the inclusive bound winning a tie) would not change results; it is an equivalent mutant, visible only in EXPLAIN.
  - `REVIEW-SQL-001` ran 31 predicates (all operators, flipped, negative, contradictory, NULL literal, OR/NOT, safe-integer extremes, BOOLEAN and TEXT indexes). Index plan = seq plan for every one.
- **DEC-006** is applied only in `sargable()` (`src/exec/planner.ts:42`). The executor encodes only sargable bounds and DML encodes only stored values (≤ 512 bytes by construction), so the policy is consistent end to end.
- **DN-1 (DC-43):** `SELECT id FROM t WHERE x * 2 > 0 AND id = 1` returns `[[1]]` with the PK index and fails with `INTEGER_OVERFLOW` under `forceSeqScan`. This is allowed by DC-43 (pinned in `REVIEW-SQL-001`); see DG-3.

## 14. Error / FAILED-state Audit

- **Hierarchy:** `MiniDbError` → 9 subclasses with fixed code lists (`codes.ts`); `check:docs` ties the codes to SPEC H.2.
- **Catch and wrap paths traced:**
  - `Pager.guarded` (l.255): CorruptionError, InternalError and non-MiniDb errors → FAILED.
  - `commitTxn`: append failure → IO_COMMIT_UNKNOWN → FAILED.
  - `checkpoint`: any error → FAILED.
  - `Database.wrap` (l.93): non-MiniDb → InternalError INVARIANT_VIOLATION (cause kept) → FAILED; InternalError and CorruptionError → FAILED; `SimulatedCrash` passes through.
  - `Database.run` (l.146): on error, if the handle is still open, roll back the statement, then the transaction if it was autocommit.
- **Read I/O errors** (StorageError IO_ERROR outside commit/checkpoint/recovery) fail only the statement, which is rolled back; the handle stays open (T-FAIL-003). This is consistent with DC-49 (a), which covers only write, sync and truncate.
- **FAILED behaviour** (`REVIEW-ERR-001`):
  - After a CorruptionError on a heap page, `execute`, `executeScript`, `schema`, `integrityCheck` and `checkpoint` all raise `DB_FAILED`, with the original error kept as `cause`.
  - `close()` works; afterwards calls raise `DB_CLOSED`.
  - `stats()` and `resetStats()` still work (DG-2).
- **Opening a database** fails when a table root page is corrupt: `Catalog.load` reads every root at open. There is no salvage or read-only mode, which is documented (DN-3).
- **Determinism:** error positions come from tokens and AST nodes, and the check order is fixed (left to right; PK index first, then by name).
- Defect found in this area: L-1.

## 15. IntegrityCheck Audit

| Inv. | Code | Complete? |
|---|---|---|
| I1 | `integrity.ts:57-64` | catalogRoot = 1, pageCount ≥ 2, file size = pageCount×4096 only when the WAL is empty. Magic, version and CRC are verified at open (page 0 stays resident). Doc wording: DG-1. |
| I2 | l.66-75 | Pins every page. The first corrupt page is reported and the check returns early (the pager is FAILED). |
| I3 | `issues.ts:30` | Exactly one owner per page in [1, pageCount): freelist, catalog chain, heaps, trees. When a table's heap has issues, its index trees are skipped, so their pages show as *leaked*: extra noise, not a missed issue. |
| I4 | `pager.freelistPages` | Cycle, range, type, count. |
| I5 | `HeapFile.check` | Cycle, range, type, `tailPage` of the head and of other pages, end of chain. |
| I6 | `checkHeapPage` | Full formula: slot directory ≤ recordStart, live records in range and non-overlapping, fragmented bytes, last slot live, tombstones (0,0). |
| I7 | `HeapFile.check` + `decodeRow` | Decode, NOT NULL, safe integers, UTF-8. |
| I8 | `BTree.check` | Equal leaf depth, internal count ≥ 1, leaf chain visits every leaf in order and ends with 0. |
| I9 | `BTree.check`, `checkNodeGeometry` | In-node order, separator bounds, no duplicate unique keys, keyLen ≤ 512. |
| I10 | `checkNodeGeometry` | Pointer and cell geometry, overlaps, fragmented bytes. |
| I11 | l.112-134 | Exact multiset comparison; now tested for content, not just count (TG-1). |
| I12 | `Catalog.load` | All D.7 rules. |
| I13 | `checkNoPins` | Asserted at statement end and at commit and rollback. |
| I14 | `beginTxn` invariant | Dirty set and `headerBefore` empty; page 0 presence implicit. |
| I15 | `pin` l.343 | Frame < `wal.frames` asserted; pageId < pageCount not asserted. |
| I16 | by construction | Only `checkpoint`/`recoverOrCreate` call `data.write`. |

- One edge: if a heap row stores > 512 bytes in an indexed TEXT column, which only happens with corruption, `keyOf` throws `LimitError KEY_TOO_LARGE` out of `integrityCheck` instead of reporting an issue. This is low value and covered by DN-3's spirit.
- No invariant is claimed to be checked more fully than the code actually checks it, apart from DG-1.

## 16. Reference Model / Random Testing Audit

- **Independence:**
  - `tests/model/ref-model.ts`, `ast.ts` and `render.ts` import nothing from `src/`. `generator.ts` imports only the `Rng` *type*.
  - The model reimplements semantics independently: `Buffer.compare` for TEXT order, BigInt overflow checks, array filters and sorts, and final-state uniqueness for UPDATE (not the engine's per-index owner lookup).
  - No production algorithm (key codec, page layout, B+tree) is copied.
  - Schema state is shared with the generator only to pick valid names. REVIEW_PACKET §8 admits this.
- **Coverage of the generator, as read from the code:**

| Feature | Covered? |
|---|---|
| Duplicate values | Integers in [−20, 20] and a small TEXT pool |
| NULL | 15% of values |
| Transactions with rollback | Yes |
| Long TEXT for row moves and KEY_TOO_LARGE | 6% of values at 300–650 bytes |
| Index vs no-index | Yes, via the `withIndexes` variant and T-DIFF-001 |
| Deletes | Yes |

  - Weaker areas: B+tree depth (TG-5), size limits (TG-4), TEXT/BOOLEAN PKs.
- **Why the row-move mutation was missed before, and whether that is fixed:**
  - Before the fix, rows never grew enough to leave their page.
  - With 6% long TEXT, the short model test (`T-MODEL-002`/`003` in `npm test`) now catches the mutant on its own (M8).
  - T-IDX-002, T-EXEC-004 and the new REVIEW-RM-001 also catch it.

## 17. Fault Injection / Crash Harness Audit

- **`MemoryVfs`** keeps three views per file: `current`, `durable` (as of the last `sync`) and an ordered `pending` list. A sync makes `current` durable. Files that were never directory-synced vanish under P-DURABLE.
- **Crash policies:**
  - P-DURABLE: only synced state survives.
  - P-ALL: everything written survives.
  - P-TORN: the durable state plus the torn prefix of the crashing write.
  - P-RANDOM: each pending write is independently lost, applied, or kept as a 512-byte-aligned prefix; each truncate is applied 50/50.
- **Assessment:**
  - These faithfully model lost unsynced writes, prefix tears and partial persistence.
  - Not modelled: sector reordering within a write, misdirected writes, failed-fsync page dropping (fsyncgate, which the engine sidesteps by going FAILED), and the Windows lack of directory durability (`MemoryVfs.syncDir` always succeeds). See TG-3.
- **`FaultVfs`:**
  - Every write, sync, truncate and syncDir gets a global sequence number.
  - `crashAtOp` makes all later calls throw (except `close`) and optionally applies `tornBytes`.
  - `failAtOp` injects an EIO with no effect; `failReadAt` injects a read error.
- **Oracle:**
  - Expected states come from the reference model, never from a fault-free engine run.
  - The allowed results are the acked state plus the in-flight candidate.
  - Two reopens must give the same state, and integrity must be clean.
  - This is a sound oracle.
- **Re-measured in this session:** `test:crash` passes in full on Node 24 and Node 20. The extended recovery crashes are in §10.

## 18. Mutation Sanity Check

All mutations are **new**: the implementation phase did not use them. Each was applied temporarily and restored with `git checkout`, and `git diff -- src` was clean after every run. The runner is a scratch script outside the repository.

| ID | Mutation | Caught by `npm run check`? | Caught by |
|---|---|---|---|
| M1 | `scanWal` applies the uncommitted tail | ✅ | T-WAL-003, T-CRASH-P03, T-CORR-002 |
| M2 | Recovery skips F5 (`data.sync()` in replay) | ✅ | T-PGR-012 (random pager model) |
| M3 | WAL reset skips F2 (sync after truncate) | ✅ | T-CRASH-004 (protocol trace), T-CRASH-P03 (**`WAL_HEADER_INVALID`, the database cannot be opened**), T-WAL-003/004 (stale transactions reappear) |
| M4 | B+tree scan ignores an exclusive lower bound | ✅ | T-BT-004, T-BT-005. Not visible through SQL, because of the DC-70 filter |
| M5 | Statement rollback does not restore pages already dirty in the transaction | ✅ | T-PGR-008/011/012, T-EXEC-002/008/015, model tests, golden |
| M6 | Checkpoint skips cached pages | ✅ | About 25 tests |
| M7 | DELETE maintains only the first index | ✅ | T-IDX-002/004, T-EXEC-006, T-MODEL-002, T-INTEG-001 teardown |
| M8 | UPDATE skips index maintenance on row move (the mutant missed earlier) | ✅ | T-MODEL-002/003, T-IDX-002, T-EXEC-004, T-CORR-001/003; REVIEW-RM-001 |
| M11 | I11 compares counts only | ❌ **survived** | Killed only by the new REVIEW-INT-001 (TG-1) |
| M18 | No OR short-circuit | ✅ | T-EVAL-001/005, T-MODEL-*, golden |
| M19 | `NULL AND FALSE` evaluates to NULL | ✅ | T-EVAL-001, T-DIFF-001, T-MODEL-*, golden |

- **Score:** 10 of 11 caught by `npm run check` alone; 11 of 11 with the review tests.
- **M3 matters:** F2 looks redundant (F3 syncs the same file), but it is not. Without it, a torn new header over an untruncated WAL makes the database unopenable. The existing suite catches this.

## 19. Environment / Platform Limitations

- **Windows:** directory fsync is a no-op (F1 is ineffective; new-file durability relies on NTFS metadata journaling). Accepted (DC-53).
- **Not tested:** real power loss, and real OS or disk cache behaviour. All crash claims are relative to the `MemoryVfs`/`FaultVfs` model.
- **Node 20:** v20.20.2 ran `typecheck`, `check:any`, `check:docs`, `vitest run`, `test:random`, `test:crash` and the review suite. All passed.
  - Not tested: Node 20 on Linux or macOS; NodeVfs on a POSIX file system (where `syncDir` is real).
  - The NodeVfs paths exercised were T-PGR-016 (byte-identical files from NodeVfs and MemoryVfs), the lock tests and the CLI tests, all on Windows.
- **Multi-process:** cooperative lock only; see L-2.

## 20. Recommended Fix Order

1. **L-1:** argument validation in `execute`/`executeScript` (small; makes `REVIEW-API-001` pass).
2. **TG-1:** move `REVIEW-INT-001` into `tests/integration/integrity.test.ts` (or reference it from T-INTEG-002) so M11 is killed by `npm run check`.
3. **DG-1 … DG-5:** wording fixes in DURABILITY I1, DC-49, DEC-006, REVIEW_PACKET §1, and the Node 20 status in LIMITATIONS and REVIEW_PACKET.
4. **TG-2:** fold torn/random recovery re-crash (`REVIEW-CR-001`) into `test:crash` (T-CRASH-P02 and CW6 policy lists).
5. **L-2:** either make stale-lock takeover atomic or document the race explicitly.
6. **Optional:** TG-4/TG-5 generator tweaks (TEXT PKs, occasional rows near 4060 bytes, a few 400-byte indexed keys); TG-3 non-prefix tear policy.

## 21. Final Assessment

- **Is there a Core blocker?** **No.**
  - No Critical, High or Medium finding.
  - No reproduced data loss, corruption, atomicity violation or wrong query result.
- **Is the implementation portfolio-ready?**
  - **Yes, in its current form.**
  - The durability protocol is implemented exactly as designed, and the evidence suite is unusually strong for a project of this size: model-based, exhaustive crash points, and a sound oracle.
  - The mutation results show the tests have real teeth.
  - L-1 and the doc wording fixes are cheap and worth doing before showing the project.
- **Which findings need re-review after fixing?**
  - L-1: re-run `REVIEW-API-001`, and check that FAILED is still entered for real InternalErrors (T-ERR-003).
  - L-2: if code changes, re-run the lock tests T-LOCK-*.
  - TG-1/TG-2: if tests are moved into the main suites, re-run M11 and confirm it dies under `npm run check`.
  - The doc fixes need only a `check:docs` run.
- **How far can the atomicity/durability/integrity claims be trusted, within the known limits?**
  - Statement and transaction atomicity, durability of acknowledged commits, idempotent recovery (including crashes during recovery under every modelled policy), and the I1–I12 structural integrity after any modelled crash can be trusted at a **high level of confidence within the `FaultVfs` model and a single process**.
  - The trust does **not** extend to:
    - real power loss or OS/disk caches that differ from the model;
    - Windows new-file durability, which relies on NTFS (DC-53);
    - concurrent multi-process access;
    - mid-WAL corruption, which is silently truncated, as documented.

---

## 22. Post-review fix status (fix session R1, appended after the review)

This section was added in the follow-up fix session. Sections 1–21 above are unchanged and describe commit `b58d809`. See DEC-007.

| Finding | Status | Where |
|---|---|---|
| L-1 | **Fixed.** `execute`/`executeScript` check their argument types and raise `UsageError INVALID_OPTION`. The handle and any open transaction are untouched. Engine InternalError, CorruptionError and storage failures still enter FAILED (T-ERR-003 unchanged). REVIEW-API-001 now passes 4/4 without modification. | `src/engine/database.ts`, T-ERR-004 |
| L-2 | **Documented, not changed** (out of v1 scope: single process, cooperative lock). Atomic takeover is listed as a FUTURE item. | DURABILITY DC-52 and G.15 step 6, LIMITATIONS, REVIEW_PACKET §8, FUTURE |
| TG-1 | **Closed.** T-INTEG-004 is in `tests/integration/integrity.test.ts`; mutation M11 re-applied → `npm run check` fails (T-INTEG-004); source restored, `git diff -- src` clean. | T-INTEG-004 |
| TG-2 | **Closed** (deterministic subset). T-CRASH-006 in `test:crash`: CW4/CW5, P-TORN (1, 2048 bytes), P-RANDOM (1 seed), double crashes. About 1,180 recovery crashes and 160 double crashes in about 6 s; scale up with `CRASH_RECOVERY_STRIDE` and `CRASH_RECOVERY_SEEDS`. It detects mutation M2 (recovery without F5) on its own. | T-CRASH-006 |
| DG-1 … DG-5 | **Fixed** in DURABILITY (I1, DC-49), DECISIONS (DEC-006 scope, DEC-007), SPEC appendix, REVIEW_PACKET §1/§7/§8/§10, LIMITATIONS. | DEC-007 |
| TG-3 … TG-6, DN-1 … DN-5 | Open by design (FUTURE / Design Notes). | FUTURE.md |

Re-verified after the fixes:

| Run | Node 24 | Node 20 |
|---|---|---|
| `npm run check` | 167 tests, 156/156 test IDs | same steps run directly with Node 20: 167 tests |
| `test:random` | 3/3 | 3/3 |
| `test:crash` | 6/6 | 6/6 |
| review suite | 29/29 | 29/29 |

Both Node versions were run on Windows 11.
