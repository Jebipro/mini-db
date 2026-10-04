/**
 * Language-level limits (C.2 DC-11..DC-14). They live in util/ so the SQL layer can use them without
 * depending on storage/ (E.2); storage/layout.ts re-exports them next to the on-disk constants.
 */
export const MAX_KEY_BYTES = 512;
export const MAX_TEXT_BYTES = 4000;
export const MAX_COLUMNS = 64;
export const MAX_IDENTIFIER_BYTES = 64;
export const MAX_SAFE = Number.MAX_SAFE_INTEGER;
