/** Physical I/O counters (E.4 DbStats.io). Shared by the WAL file and the pager. */
export interface IoStats {
  dataPageReads: number;
  dataPageWrites: number;
  walFrameReads: number;
  walFrameWrites: number;
  dataSyncs: number;
  walSyncs: number;
  dirSyncs: number;
  walTruncates: number;
}

export function createIoStats(): IoStats {
  return {
    dataPageReads: 0,
    dataPageWrites: 0,
    walFrameReads: 0,
    walFrameWrites: 0,
    dataSyncs: 0,
    walSyncs: 0,
    dirSyncs: 0,
    walTruncates: 0,
  };
}

export function resetIoStats(s: IoStats): void {
  Object.assign(s, createIoStats());
}
