# FUTURE

Stretch items in priority order (DESIGN_REVIEW.md O.1) and deferred items (O.2).

| Priority | Item | Why | Depends on |
|---|---|---|---|
| 1 | Aggregates `COUNT/SUM/MIN/MAX` | One executor operator, high learning value | — |
| 2 | `GROUP BY` | Natural extension (hash or sort based) | 1 |
| 3 | Two-table `INNER JOIN` (nested loop → index nested loop) | Planner learning | — |
| 4 | Auto-checkpoint tuning | Use BENCHMARKS B9 (recovery time vs WAL size) | — |
| 5 | B+tree merge/redistribute | Only if B10-style churn shows real bloat | — |
| 6 | Composite indexes | Needs a prefix-safe multi-column key encoding | — |
| 7 | `REAL` type | Order-preserving float encoding, NaN rules | — |

Deferred from the review: SELECT-list expressions and aliases; `IF [NOT] EXISTS`; quoted identifiers; heap
free-space map; index-ordered scans for ORDER BY and top-N sort; VACUUM; full int64 via bigint (format already
int64); read-only / salvage open mode; WAL mid-log corruption detection (needs a format v2 with per-frame
transaction markers); real power-loss experiments.

From the independent review (CLAUDE_INDEPENDENT_REVIEW.md): atomic multi-process stale-lock takeover (L-2, e.g.
rename-based takeover plus re-read of the PID, or OS advisory locks); fault-model extensions TG-3 (non-prefix
sector tears, misdirected writes), generator coverage TG-4/TG-5 (TEXT/BOOLEAN primary keys, rows near the
4060-byte limit, deeper B+trees), TG-6 (salt reuse across WAL generations in crash tests).
