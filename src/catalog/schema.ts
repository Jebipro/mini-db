import type { ColumnType } from '../record/value.js';
import type { PageId } from '../storage/pager.js';

export interface ColumnSchema {
  name: string;
  type: ColumnType;
  notNull: boolean;
  primaryKey: boolean;
  position: number;
}

export interface IndexSchema {
  name: string;
  table: string;
  column: string;
  unique: boolean;
  root: PageId;
  /** The automatic PRIMARY KEY index `mdb_pk_<table>` (DC-45). */
  auto: boolean;
}

export interface TableSchema {
  name: string;
  columns: ColumnSchema[];
  heapHead: PageId;
  /** Sorted by name. */
  indexes: IndexSchema[];
}

export const RESERVED_PREFIX = 'mdb_';
export const PK_INDEX_PREFIX = 'mdb_pk_';

export function pkIndexName(table: string): string {
  return `${PK_INDEX_PREFIX}${table}`;
}

export function columnTypes(t: TableSchema): ColumnType[] {
  return t.columns.map((c) => c.type);
}

export function primaryKeyColumn(t: TableSchema): ColumnSchema | undefined {
  return t.columns.find((c) => c.primaryKey);
}

export function columnIndex(t: TableSchema, name: string): number {
  return t.columns.findIndex((c) => c.name === name);
}

/** Identifier syntax after normalization (DC-13, DC-40). */
export const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;
