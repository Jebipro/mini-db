// check:any — finds explicit `any` in src/ via the TypeScript compiler API (DC-02, J.9),
// plus forbidden nondeterminism (DC-66): Math.random in src/ and tests/, Date.now / new Date in src/.
// Exception: a line containing `// any-allowed: <reason>` may use `any`.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('..', import.meta.url));

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const problems = [];

for (const file of walk(join(root, 'src'))) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      if (!/\/\/ any-allowed: \S/.test(lines[line] ?? '')) {
        problems.push(`${relative(root, file)}:${line + 1}: explicit any`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  lines.forEach((l, i) => {
    const code = l.replace(/\/\/.*$/, '');
    if (/\bMath\.random\b/.test(code)) problems.push(`${relative(root, file)}:${i + 1}: Math.random`);
    if (/\bDate\.now\b|\bnew Date\b/.test(code)) problems.push(`${relative(root, file)}:${i + 1}: wall-clock time in src`);
  });
}

for (const file of walk(join(root, 'tests'))) {
  readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .forEach((l, i) => {
      if (/\bMath\.random\b/.test(l.replace(/\/\/.*$/, ''))) problems.push(`${relative(root, file)}:${i + 1}: Math.random`);
    });
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(`check:any failed (${problems.length} problem(s))`);
  process.exit(1);
}
console.log('check:any ok');
