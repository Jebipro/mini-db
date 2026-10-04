# BENCHMARKS

Run with `npm run bench` after the correctness gate (P15). Raw results:
[`bench/results/20261003-183058-7c3e98f.json`](bench/results/20261003-183058-7c3e98f.json).
These numbers compare design choices inside this engine; they are not performance targets.

## Environment

| Item | Value |
|---|---|
| Node | v24.16.0 |
| OS | Windows 11 (win32 10.0.26200) |
| CPU | AMD Ryzen 5 3600, 12 logical CPUs |
| Memory | 32 GiB |
| Disk | local NTFS, unspecified SSD (`BENCH_DISK`) |
| Commit | 7c3e98f |
| Method | seed 42, 1 warm-up + 5 measured runs, median and IQR; I/O = counter delta of the last run; write scenarios use a fresh file per run |

Schema: `items (id INTEGER PRIMARY KEY, grp INTEGER NOT NULL, name TEXT NOT NULL, flag BOOLEAN)`, `name` 8–24 ASCII
letters, `grp` in [0, 999]; a secondary index on `grp` for read scenarios.

## Results

| ID | Variant | Median | IQR | Key I/O |
|---|---|---|---|---|
| B1 | 2,000 autocommit INSERTs | 1,439 ms (720 µs/row) | 34 ms | 2,010 WAL fsyncs |
| B2 | 2,000 rows, one transaction | 42 ms (21 µs/row) | 2 ms | 3 WAL fsyncs (1 commit + checkpoint at close) |
| B2 | 100,000 rows, one transaction | 2,454 ms (25 µs/row) | 123 ms | 1,910 WAL frames, 3 WAL fsyncs |
| B3 | 1,000 PK lookups (warm) | 42 ms (42 µs/op) | 3 ms | 0 physical reads (cache hit rate 1.0) |
| B3 | 50 lookups on unindexed `name` | 14,499 ms (290 ms/op) | 388 ms | full scan each |
| B3 | one cold PK lookup | 0.19 ms | — | 3 physical page reads |
| B4 | `grp = 5` (0.1%) index / seq | 0.44 ms / 232 ms | | |
| B4 | `grp < 10` (1%) index / seq | 5.2 ms / 178 ms | | |
| B4 | `grp < 100` (10%) index / seq | 34 ms / 186 ms | | |
| B5 | full scan `SELECT *`, 100k rows | 203 ms (≈ 493k rows/s) | 21 ms | |
| B6 | UPDATE 10% same size | 98 ms | 0.4 ms | 102 WAL frames |
| B6 | UPDATE 10% growing rows (moves) | 470 ms | 4 ms | 1,541 WAL frames |
| B6 | DELETE 10% | 253 ms | 25 ms | 794 WAL frames |
| B7 | `ORDER BY name` full / `LIMIT 10` | 2,091 ms / 2,032 ms | | |
| B8 | 5,000 random PK lookups, cache 64 / 256 / 1024 / 4096 / 16384 pages | 327 / 312 / 310 / 254 / 257 ms | | hit rate 0.715 / 0.749 / 0.865 / 1.0 / 1.0 |
| B9 | open (recovery) with WAL of 0 / 100 / 1,000 / 10,001 frames | 2.4 / 7.9 / 33.6 / 285 ms | | distinct pages replayed 0 / 15 / 125 / 1,232 |
| B10 | 10k rows, 10 rounds of "delete 50% + reinsert" | pages 288 → 334 → 358 → … → 377 (plateau from round 7) | | freelist 0 |

## Sanity checks (K.5)

| ID | Expectation | Observed |
|---|---|---|
| S1 | Indexed lookup far cheaper than a scan at 100k rows | 42 µs vs 290 ms per lookup (~7,000×) |
| S2 | Autocommit = 1 WAL fsync per row; one transaction = 1 | 2,010 vs 3 (incl. close checkpoint) ✓ |
| S3 | Hit rate never decreases with cache size | 0.715 → 0.749 → 0.865 → 1.0 → 1.0 ✓ |
| S4 | Recovery time roughly linear in WAL size | 7.9 → 33.6 → 285 ms for 100 → 1k → 10k frames ✓ (dominated by scanning; replay writes only the latest image per page) |
| S5 | Index wins at 0.1%; record the crossover | Index still 5× faster at 10%; no crossover measured up to 10% (rows are small and the heap is read via the cache) |
| S6 | Cold PK lookup ≈ tree height + 1 reads | 3 reads = 2-level B+tree + 1 heap page (page 0 is resident) ✓ |
| S7 | `LIMIT 10` costs about the same as a full sort | 2,032 vs 2,091 ms ✓ (no top-N optimization, as designed) |
| S8 | Page growth under churn | +31% then a plateau: tail-page insertion plus lazy B+tree deletion stabilise — DC-61 / C.1.4 reversal conditions not met |

## Interpretation

- Commit cost is the WAL fsync (~0.7 ms each on this machine, `FlushFileBuffers`); batching statements in a
  transaction is ~30× cheaper per row.
- `ORDER BY` on 100k rows spends most time in the comparator (UTF-8 byte comparison re-encodes strings per
  comparison). This is the first optimization candidate if needed: measure → hypothesis (cache encoded keys in
  Sort) → change → re-measure, then re-run `npm run check` and `npm run test:crash`.
- No optimization was applied in P16; there is therefore no before/after record yet.
