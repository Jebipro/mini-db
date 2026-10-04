/**
 * File-system abstraction (DC-03, E.4). All engine I/O goes through these interfaces so that
 * crash semantics can be simulated (MemoryVfs / FaultVfs) and Node fs stays in one module.
 */
export interface StorageFile {
  readonly path: string;
  size(): number;
  /** Reads into `dst` starting at `position`; returns bytes read (short only at EOF). */
  read(dst: Uint8Array, position: number): number;
  /** Writes all of `src` at `position` (extending the file, zero-filling any gap) or throws. */
  write(src: Uint8Array, position: number): void;
  sync(): void;
  truncate(size: number): void;
  close(): void;
}

export interface LockHandle {
  release(): void;
}

export interface Vfs {
  exists(path: string): boolean;
  /** Opens the file, creating it if absent. */
  open(path: string): StorageFile;
  /** fsync of a directory (F1). Returns false when the platform cannot do it (no-op). */
  syncDir(dirPath: string): boolean;
  /** Cooperative lock for a database path (G.15). Throws StorageError DB_LOCKED. */
  acquireLock(dbPath: string): LockHandle;
}

export function walPathOf(dbPath: string): string {
  return `${dbPath}-wal`;
}

export function lockPathOf(dbPath: string): string {
  return `${dbPath}-lock`;
}
