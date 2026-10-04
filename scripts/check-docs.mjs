// check:docs — document/code traceability (J.9, L).
// Default mode:
//   1. error codes in src/errors/codes.ts == codes in the SPEC.md H.2 table
//   2. every `// FSYNC-Fn` tag in src/ names an fsync point listed in DURABILITY.md
//   3. every test ID used in tests/ (it/test/describe titles starting with T-…) is defined in TESTING.md
// --final mode additionally requires:
//   4. every T-ID defined in TESTING.md and every T-ID referenced by the DESIGN_REVIEW.md risk register exists in tests/
//   5. every fsync point F1..F5 has at least one tag in src/
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const uptoArg = process.argv.find((a) => a.startsWith('--upto='));
const upto = uptoArg ? Number(uptoArg.slice('--upto='.length)) : Infinity;
const final = process.argv.includes('--final') || uptoArg !== undefined;
const read = (p) => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n');

function walk(dir, exts, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}

/** Lines of the markdown section starting at a heading that begins with `prefix`. */
function sectionLines(text, prefix) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(prefix));
  if (start < 0) return [];
  const level = prefix.match(/^#+/)[0].length;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+) /);
    if (m && m[1].length <= level) break;
    out.push(lines[i]);
  }
  return out;
}

const problems = [];

// 1. error codes
const codesTs = read('src/errors/codes.ts');
const codeSet = new Set([...codesTs.matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]));
const spec = read('SPEC.md');
const specCodes = new Set(
  sectionLines(spec, '## H.2')
    .map((l) => l.match(/^\| [A-Za-z]+Error \| `([A-Z][A-Z0-9_]*)` \|/))
    .filter(Boolean)
    .map((m) => m[1]),
);
if (specCodes.size === 0) problems.push('SPEC.md: H.2 error table not found');
for (const c of codeSet) if (!specCodes.has(c)) problems.push(`codes.ts code ${c} missing from SPEC.md H.2`);
for (const c of specCodes) if (!codeSet.has(c)) problems.push(`SPEC.md code ${c} missing from codes.ts`);

// 2. fsync tags
const durability = read('DURABILITY.md');
const fsyncPoints = new Set(
  durability
    .split('\n')
    .map((l) => l.match(/^\| (F[0-9]+) \|/))
    .filter(Boolean)
    .map((m) => m[1]),
);
const usedTags = new Map();
for (const f of walk(join(root, 'src'), ['.ts'])) {
  read(relative(root, f))
    .split('\n')
    .forEach((l, i) => {
      for (const m of l.matchAll(/FSYNC-(F[0-9]+)/g)) {
        if (!fsyncPoints.has(m[1])) problems.push(`${relative(root, f)}:${i + 1}: unknown fsync tag ${m[1]}`);
        usedTags.set(m[1], (usedTags.get(m[1]) ?? 0) + 1);
      }
    });
}

// 3. test IDs
const testing = read('TESTING.md');
/** T-ID → earliest phase number in the row's last column (e.g. "P5, P14" → 5). */
const phaseOf = new Map();
const definedIds = new Set();
for (const l of testing.split('\n')) {
  const m = l.match(/^\| (T-[A-Z]+-[A-Z0-9]+) \|/);
  if (!m) continue;
  definedIds.add(m[1]);
  const cols = l.split('|').map((c) => c.trim()).filter(Boolean);
  const phases = [...(cols[cols.length - 1] ?? '').matchAll(/P(\d+)/g)].map((x) => Number(x[1]));
  phaseOf.set(m[1], phases.length > 0 ? Math.min(...phases) : 0);
}
const usedIds = new Set();
for (const f of walk(join(root, 'tests'), ['.ts'])) {
  for (const m of read(relative(root, f)).matchAll(/\b(?:it|test|describe)(?:\.\w+)?\(\s*['"`](T-[A-Z]+-[A-Z0-9]+)/g)) {
    usedIds.add(m[1]);
    if (!definedIds.has(m[1])) problems.push(`${relative(root, f)}: test ID ${m[1]} not defined in TESTING.md`);
  }
}

if (final) {
  const design = read('DESIGN_REVIEW.md');
  const riskIds = new Set(sectionLines(design, '## I.').join('\n').match(/T-[A-Z]+-[A-Z0-9]+/g) ?? []);
  for (const id of new Set([...definedIds, ...riskIds])) {
    if ((phaseOf.get(id) ?? 0) > upto) continue;
    if (!usedIds.has(id)) problems.push(`test ID ${id} has no test`);
  }
  for (const f of fsyncPoints) if (!usedTags.has(f)) problems.push(`fsync point ${f} has no FSYNC-${f} tag in src/`);
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(`check:docs failed (${problems.length} problem(s))`);
  process.exit(1);
}
console.log(`check:docs ok${final ? ' (final)' : ''}: ${codeSet.size} codes, ${usedIds.size}/${definedIds.size} test IDs used, fsync tags ${[...usedTags.keys()].sort().join(',') || '-'}`);
