# REVIEW_PACKET

For an independent reviewer who has not seen the development history.

## 1. What the system claims

- **Atomicity**: every statement is all-or-nothing; a transaction (explicit or autocommit) is all-or-nothing
  across crashes.
- **Durability**: once `execute('COMMIT')` (or an autocommit statement) returns, the change survives a crash.
- **Integrity**: after any crash in the fault model, the database reopens, passes `integrityCheck()`
  (I1–I12), and contains exactly the acknowledged commits plus, possibly, the one in flight.
- **Detection**: a bit flip in a page image that is **read** (data file or WAL frame) is detected by the per-page
  CRC32 and reported as `CorruptionError` or an integrity issue; the handle then refuses data access (FAILED).
  Two cases are not reported (see §8): a bit flip in the middle of the WAL breaks the checksum chain and is
  treated like a torn tail, so later commits are discarded; and a corrupted data-file page that has a newer
  committed image in the WAL is never read and is silently overwritten by the next checkpoint or recovery.

## 2. Assumptions (fault model)

A crash loses an arbitrary subset of writes not yet covered by an fsync of the same file, and any write may
persist as a prefix (torn). File creations are durable only after a directory fsync (not available on Windows,
see LIMITATIONS). fsync either succeeds (everything earlier in that file is durable) or the handle fails.
Implemented by `src/storage/memory-vfs.ts` + `src/storage/fault-vfs.ts`, themselves tested (T-VFS-003…007).

## 3. Mechanism in one paragraph

No-steal page cache: uncommitted pages never reach disk. Commit appends the transaction's dirty page images
to the WAL (one write per frame, checksum chain seeded by the WAL header CRC, COMMIT flag on the last frame) and
fsyncs (F4). Reads go cache → WAL index → data file. Checkpoint copies the latest committed images into the data
file, fsyncs it (F5), then truncates the WAL, fsyncs (F2), writes a new header with new salts, fsyncs (F3).
Opening always recovers: committed frames are replayed, the data file is fsynced, the WAL is reset. Database
creation is itself a WAL transaction.

## 4. fsync points and code locations

| ID | Where | Purpose |
|---|---|---|
| F1 | `src/storage/pager.ts:136` | directory fsync after creating files |
| F2 | `src/storage/wal.ts:196` | WAL truncate durable before a new header |
| F3 | `src/storage/wal.ts:206` | new WAL header durable before any frame |
| F4 | `src/storage/wal.ts:231` | **commit point** |
| F5 | `src/storage/pager.ts:629` (checkpoint), `src/storage/pager.ts:175` (recovery) | data file durable before the WAL is reset |

## 5. Invariants

Structural I1–I12 (checked by `src/engine/integrity.ts:39`), runtime I13–I16 (assertions in
`src/storage/pager.ts`), durability D1–D7 — all listed in DURABILITY.md G.10.

## 6. How to run the evidence

```bash
npm run check
```

```bash
npm run test:random
```

```bash
npm run test:crash
```

Last recorded results are in PROGRESS.md (e.g. 1000 seeds × 1000 steps × 3 random suites; ~3000 SQL-level crash
cases, ~4100 recovery re-crashes, 902 page-level crash cases).

## 7. Fault-injection coverage and its limits

Covered: every write/sync/truncate/syncDir of the page-level workload PW1 and SQL workloads CW1–CW5 under
P-DURABLE, P-ALL, P-TORN (1, 511, 512, 4096, len−1 bytes), P-RANDOM (3 seeds); crashes during recovery
(CW6, PW1 under P-DURABLE/P-ALL; CW4/CW5 under P-TORN, P-RANDOM and double crashes, T-CRASH-006); crashes during creation; random workloads with random crash points; I/O errors on write, fsync and
read; bit flips in every page type and in the WAL.

Not covered: real power loss; OS page-cache behaviour beyond the model; misdirected or phantom writes not at a
crash point; out-of-order sector persistence inside one write (tears are modelled as prefixes only);
multi-process access; Windows directory durability. Node 20 was verified on Windows only (v20.20.2:
typecheck, check:any, check:docs, npm test, test:random, test:crash, review suite); other OSes untested.

## 8. Known weaknesses

- WAL mid-log corruption silently truncates history (consistent but loses later commits).
- A data-file page corrupted while a newer image of it sits in the WAL is overwritten at checkpoint/recovery
  without being reported (the result is correct; the corruption simply goes unnoticed).
- Stale-lock takeover is not atomic: two processes that find the same stale lock at the same moment can both
  acquire it (independent review L-2). v1 guarantees single-process use with a cooperative lock only.
- After FAILED, `close()` and the read-only diagnostics `state`, `inTransaction`, `stats()`, `resetStats()` still
  work; every data access raises `DB_FAILED` (DC-49 as clarified in DEC-007).
- Heap space reuse is limited to the tail page (file growth under churn).
- Statement-level uniqueness check reads the B+tree once per new key; UPDATE materializes all targets.
- The reference model and the engine share the generator's view of the schema, so schema-level semantics
  (e.g. name rules) are checked by unit tests rather than the model.

## 9. Where to look first (risk order)

1. `src/storage/pager.ts` `recoverOrCreate` (l.151), `commitTxn` (l.567), `checkpoint` (l.607)
2. `src/storage/wal.ts` `scanWal` (l.109), `reset` (l.187)
3. `src/storage/pager.ts` `rollbackStatement` / `rollbackTxn` (l.517, l.542) — page 0 restored in place
4. `src/exec/dml.ts` `executeUpdate` (l.86) — row moves and index maintenance
5. `src/btree/btree.ts` `insertIntoParent` / `splitRoot` (l.199, l.184)
6. `src/engine/database.ts` `run` (l.174) — statement/transaction lifecycle, error wrapping (l.116), API argument checks (`checkSql`, `checkExecuteOptions`)

## 10. Independent review

[CLAUDE_INDEPENDENT_REVIEW.md](CLAUDE_INDEPENDENT_REVIEW.md) (review of `b58d809`): 0 Critical/High/Medium, 2 Low,
6 test gaps, 5 documentation gaps. Fixed afterwards (DEC-007): L-1 (T-ERR-004), TG-1 (T-INTEG-004), TG-2
(T-CRASH-006), DG-1…DG-5; L-2 documented. The review tests run with
`npx vitest run --config vitest.review.config.ts`.
