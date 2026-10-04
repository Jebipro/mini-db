import { cpus, platform, release, totalmem } from 'node:os';

/** Benchmark statistics and report shapes (K.3, K.4). */
export interface TimeStats {
  median: number;
  min: number;
  max: number;
  iqr: number;
}

export interface IoDelta {
  dataPageReads: number;
  walFrameReads: number;
  dataPageWrites: number;
  walFrameWrites: number;
  dataSyncs: number;
  walSyncs: number;
  cacheHitRate: number;
}

export interface ScenarioResult {
  id: string;
  variant: string;
  params: Record<string, number | string>;
  timeMs: TimeStats;
  unstable: boolean;
  io: IoDelta;
  extra?: Record<string, number>;
}

export interface BenchEnv {
  node: string;
  platform: string;
  release: string;
  cpu: string;
  cpus: number;
  totalMemMiB: number;
  disk: string;
  commit: string;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (pos - lo);
}

export function timeStats(samples: number[]): { stats: TimeStats; unstable: boolean } {
  const s = [...samples].sort((a, b) => a - b);
  const median = quantile(s, 0.5);
  const iqr = quantile(s, 0.75) - quantile(s, 0.25);
  const round = (x: number): number => Math.round(x * 1000) / 1000;
  return {
    stats: { median: round(median), min: round(s[0] ?? 0), max: round(s[s.length - 1] ?? 0), iqr: round(iqr) },
    unstable: median > 0 && iqr / median > 0.3,
  };
}

export function environment(commit: string): BenchEnv {
  return {
    node: process.version,
    platform: platform(),
    release: release(),
    cpu: cpus()[0]?.model ?? 'unknown',
    cpus: cpus().length,
    totalMemMiB: Math.round(totalmem() / 1024 / 1024),
    disk: process.env.BENCH_DISK ?? 'unknown',
    commit,
  };
}

export function markdownTable(results: ScenarioResult[]): string {
  const lines = [
    '| ID | variant | params | median ms | IQR ms | min–max ms | data reads | WAL reads | WAL writes | data syncs | WAL syncs | hit rate | extra |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of results) {
    const params = Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(' ');
    const extra = r.extra ? Object.entries(r.extra).map(([k, v]) => `${k}=${v}`).join(' ') : '';
    lines.push(
      `| ${r.id} | ${r.variant} | ${params} | ${r.timeMs.median}${r.unstable ? ' (unstable)' : ''} | ${r.timeMs.iqr} | ${r.timeMs.min}–${r.timeMs.max} | ${r.io.dataPageReads} | ${r.io.walFrameReads} | ${r.io.walFrameWrites} | ${r.io.dataSyncs} | ${r.io.walSyncs} | ${r.io.cacheHitRate} | ${extra} |`,
    );
  }
  return lines.join('\n');
}
