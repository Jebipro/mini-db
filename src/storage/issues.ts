/** Integrity findings (E.4 IntegrityIssue). Structural checkers in each layer return these instead of throwing. */
export type IntegrityCode =
  | 'HEADER_INVALID'
  | 'FILE_SIZE_MISMATCH'
  | 'PAGE_CORRUPT'
  | 'PAGE_LEAKED'
  | 'PAGE_MULTI_OWNED'
  | 'FREELIST_INVALID'
  | 'HEAP_CHAIN_INVALID'
  | 'SLOTTED_PAGE_INVALID'
  | 'RECORD_INVALID'
  | 'BTREE_SHAPE_INVALID'
  | 'BTREE_ORDER_INVALID'
  | 'BTREE_PAGE_INVALID'
  | 'INDEX_HEAP_MISMATCH'
  | 'CATALOG_INVALID';

export interface IntegrityIssue {
  code: IntegrityCode;
  message: string;
  pageId?: number;
  object?: string;
}

export interface PageOwner {
  owner: string;
  pages: readonly number[];
}

/** I3: every page in [1, pageCount) belongs to exactly one owner (structures + freelist). */
export function checkOwnership(pageCount: number, owners: readonly PageOwner[]): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const ownerOf = new Map<number, string>();
  for (const { owner, pages } of owners) {
    for (const id of pages) {
      const prev = ownerOf.get(id);
      if (prev !== undefined) {
        issues.push({ code: 'PAGE_MULTI_OWNED', pageId: id, object: owner, message: `page ${id} is used by both ${prev} and ${owner}` });
      } else {
        ownerOf.set(id, owner);
      }
    }
  }
  for (let id = 1; id < pageCount; id++) {
    if (!ownerOf.has(id)) issues.push({ code: 'PAGE_LEAKED', pageId: id, message: `page ${id} is not reachable from any structure or the freelist` });
  }
  return issues;
}
