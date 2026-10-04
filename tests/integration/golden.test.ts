import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runGolden } from '../support/golden.js';

const dir = new URL('../sql/', import.meta.url);
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

describe('SQL golden suite', () => {
  it('T-GOLD-001 every tests/sql/*.sql produces its .expected output', () => {
    expect(files.length).toBeGreaterThanOrEqual(15);
    for (const f of files) {
      const actual = runGolden(readFileSync(new URL(f, dir), 'utf8'));
      const expectedUrl = new URL(f.replace(/\.sql$/, '.expected'), dir);
      if (process.env.UPDATE_GOLDEN === '1' || !existsSync(expectedUrl)) writeFileSync(expectedUrl, actual);
      const expected = readFileSync(expectedUrl, 'utf8').replace(/\r\n/g, '\n');
      expect(actual, f).toBe(expected);
    }
  });
});
