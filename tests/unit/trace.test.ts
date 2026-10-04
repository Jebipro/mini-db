import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Phase whose test IDs must all exist (raised as phases complete; 17 = final gate). */
const PHASE = 17;

describe('traceability', () => {
  it('T-TRACE-001 every risk-register and TESTING.md test ID up to the current phase has a test; fsync tags complete', () => {
    const script = fileURLToPath(new URL('../../scripts/check-docs.mjs', import.meta.url));
    const r = spawnSync(process.execPath, [script, PHASE >= 17 ? '--final' : `--upto=${PHASE}`], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});
