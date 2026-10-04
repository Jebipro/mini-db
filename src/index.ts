// Public API. Grows as phases land (Database, MemoryVfs, …).
export {
  MiniDbError,
  SqlSyntaxError,
  SemanticError,
  ConstraintError,
  TransactionError,
  LimitError,
  StorageError,
  CorruptionError,
  InternalError,
  UsageError,
  isMiniDbError,
} from './errors/errors.js';
export type { SourcePosition } from './errors/errors.js';
export type { ErrorCode } from './errors/codes.js';
export { Database } from './engine/database.js';
export type { OpenOptions, ExecResult, ExecuteOptions, DbStats, IntegrityReport, TableInfo } from './engine/database.js';
export type { IntegrityIssue, IntegrityCode } from './storage/issues.js';
export { MemoryVfs } from './storage/memory-vfs.js';
export { NodeVfs } from './storage/node-vfs.js';
export type { Vfs, StorageFile, LockHandle } from './storage/vfs.js';
export type { Value } from './record/value.js';
