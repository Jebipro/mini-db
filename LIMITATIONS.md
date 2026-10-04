# LIMITATIONS

Known, deliberate limits of Mini DB v1 (DESIGN_REVIEW.md A.4, C.2, O.2).

## Scope
- Single process, single connection, synchronous API. No concurrency control, MVCC or isolation levels.
- Language: no joins, aggregates, GROUP BY, subqueries, views, triggers, foreign keys, ALTER TABLE, expressions
  or aliases in the SELECT list, ORDER BY expressions, `IF [NOT] EXISTS`, quoted identifiers, prepared statements.
- Types: INTEGER (safe integers ±(2^53−1) only; stored as int64), TEXT (≤ 4000 UTF-8 bytes), BOOLEAN. No REAL, dates.
- Text ordering is UTF-8 byte order (no collations).
- Single-column indexes only. Indexes are used only to narrow scans, never to satisfy ORDER BY; no top-N sort.

## Storage
- A row must fit one page: ≤ 4060 encoded bytes (no overflow pages). Index keys ≤ 512 bytes.
- Heap inserts go to the table's last page (DC-61): space freed in earlier pages is reused only by updates on
  those pages, so delete-heavy workloads grow the file (see BENCHMARKS B10).
- B+tree deletion is lazy (DC-30): empty leaves stay and trees never shrink.
- The file never shrinks (no VACUUM); freed pages are reused through the freelist.
- No-steal buffering: one transaction may dirty at most `cachePages − 32` pages (`LimitError TXN_TOO_LARGE`).
- UPDATE/DELETE materialize their target rows in memory; SELECT results are returned as an array.

## Durability and verification
- Crash safety is proven against `FaultVfs`, a model of a file system (lost unsynced writes, torn writes at
  arbitrary prefixes, random subsets of unsynced writes, lost file creations). It has **not** been tested
  against real power loss or real OS/disk caches.
- A bit flip in the middle of the WAL is indistinguishable from a torn tail: commits after it are discarded
  silently (state is still a consistent committed prefix) (DC-19).
- Directory fsync is impossible from Node on Windows; new-file durability there relies on NTFS metadata
  journaling (DC-53).
- After a failed fsync or a detected corruption the handle enters FAILED; there is no salvage/read-only mode.
  Only `close()` and the read-only diagnostics (`state`, `inTransaction`, `stats()`, `resetStats()`) keep working.
- A data-file page corrupted while a newer committed image of it is in the WAL is overwritten by the next
  checkpoint/recovery without being reported.
- The lock file is cooperative (other programs can ignore it). A lock whose PID was reused by another live
  process is reported as locked (safe direction).
- v1 is **single-process**. Stale-lock takeover (read the dead PID → delete → re-create) is not atomic: if two
  processes find the same stale lock at the same moment, one can delete the lock the other just created and
  both proceed, which can corrupt the database (independent review L-2). Two handles in the same process are
  always refused (module registry). An atomic takeover is a FUTURE item.
- Verified on Windows 11 only: Node v24.16.0 and Node v20.20.2 (the declared minimum) both pass typecheck,
  check:any, check:docs, npm test, test:random, test:crash and the independent review suite. Linux/macOS
  (where directory fsync is real) have not been run.
