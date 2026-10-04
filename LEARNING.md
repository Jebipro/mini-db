# LEARNING

Concept → where it lives in the code → which tests prove it.

| Concept | Code | Verified by |
|---|---|---|
| Fixed-size pages, little-endian serialization | `src/storage/layout.ts`, `src/storage/page.ts`, `src/storage/file-header.ts` | T-PAGE-001, T-FMT-001, T-FMT-002 |
| Checksums and torn-write detection (CRC32) | `src/util/crc32.ts`, `src/storage/page.ts` | T-CRC-001, T-CRC-002, T-PAGE-002, T-CORR-001 |
| Slotted pages, RIDs, fragmentation, compaction | `src/record/heap-page.ts` | T-HP-001, T-HP-002, T-HP-003, T-HP-004 |
| Row encoding with a null bitmap | `src/record/row-codec.ts` | T-ROW-001, T-ROW-002, T-ROW-003 |
| Heap files, row moves | `src/record/heap-file.ts` | T-HEAP-001, T-HEAP-002 |
| Buffer pool: LRU, pins, dirty tracking | `src/storage/pager.ts` (`pin`, `makeRoom`, `markDirty`) | T-PGR-002, T-PGR-003, T-PGR-004 |
| Free-page list | `src/storage/pager.ts` (`allocate`, `free`, `freelistPages`) | T-PGR-005, T-CAT-004 |
| Self-describing catalog | `src/catalog/catalog.ts` | T-CAT-001, T-CAT-003 |
| B+tree search, splits, fixed root, lazy delete | `src/btree/btree.ts`, `src/btree/node.ts` | T-BT-002, T-BT-003, T-BT-006 |
| memcmp-ordered key encoding | `src/btree/key-codec.ts` | T-KEY-001, T-KEY-002 |
| Lexer, recursive descent, precedence climbing | `src/sql/lexer.ts`, `src/sql/parser.ts` | T-LEX-001, T-PAR-002, T-PAR-006 |
| Name resolution and type checking | `src/sql/analyzer.ts` | T-ANA-001, T-ANA-002 |
| Three-valued logic | `src/exec/eval.ts` | T-EVAL-001, T-EVAL-002 |
| Rule-based planning, EXPLAIN | `src/exec/planner.ts`, `src/exec/explain.ts` | T-PLAN-001, T-PLAN-002, T-EXEC-010 |
| Volcano iterators | `src/exec/operators.ts` | T-EXEC-005, T-EXEC-006 |
| Halloween problem | `src/exec/dml.ts` (`collectTargets`) | T-EXEC-004 |
| Statement-level uniqueness | `src/exec/dml.ts` (`executeUpdate`) | T-EXEC-003, T-MODEL-002 |
| No-steal buffering, savepoints, rollback | `src/storage/pager.ts` (`markDirty`, `rollbackStatement`, `rollbackTxn`) | T-PGR-007, T-PGR-008, T-PGR-011 |
| Write-ahead logging, fsync ordering, commit point | `src/storage/wal.ts` (`appendTxn`), `src/storage/pager.ts` (`commitTxn`) | T-WAL-002, T-CRASH-004, T-STAT-001 |
| Crash recovery, checkpoint | `src/storage/pager.ts` (`recoverOrCreate`, `checkpoint`), `src/storage/wal.ts` (`scanWal`, `reset`) | T-CRASH-P01, T-CRASH-001, T-CRASH-003 |
| Idempotent recovery | same | T-CRASH-P02, T-CRASH-002 |
| Failure handling (fsyncgate) | `src/storage/pager.ts` (`markFailed`), `src/engine/database.ts` (`wrap`) | T-FAIL-001, T-FAIL-002, T-ERR-003 |
| Invariant checking | `src/engine/integrity.ts`, `HeapFile.check`, `BTree.check` | T-INTEG-002, T-BT-007 |
| Test oracles, model-based testing | `tests/model/*`, `tests/support/model-runner.ts` | T-MODEL-001…005 |
| Differential testing | `tests/integration/index.test.ts` | T-DIFF-001 |
| Fault injection, deterministic replay | `src/storage/memory-vfs.ts`, `src/storage/fault-vfs.ts`, `src/util/prng.ts` | T-VFS-003…007, T-PRNG-001 |
| Benchmark methodology (warm-up, medians, I/O counters) | `bench/*` | T-BENCH-001, BENCHMARKS.md |
