#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { runCli } from './cli.js';

const rl = createInterface({ input: process.stdin, terminal: false });
const code = await runCli(process.argv.slice(2), {
  stdin: rl,
  stdout: (s) => process.stdout.write(s.endsWith('> ') ? s : `${s}\n`),
  stderr: (s) => process.stderr.write(`${s}\n`),
  readFile: (p) => readFileSync(p, 'utf8'),
  prompt: process.stdin.isTTY === true,
});
rl.close();
process.exitCode = code;
