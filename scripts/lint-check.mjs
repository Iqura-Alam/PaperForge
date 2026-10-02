import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';

const files = (await readdir('src'))
  .filter((file) => /\.(?:m?js)$/.test(file))
  .map((file) => `src/${file}`);

for (const file of files) {
  const content = await readFile(file, 'utf8');
  const syntax = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (syntax.status !== 0) throw new Error(`${file}: invalid JavaScript syntax:\n${syntax.stderr || syntax.stdout}`);
  if (file !== 'src/server.mjs' && content.includes('console.log')) throw new Error(`${file}: remove console.log`);
}
console.log(`Lint check passed: ${files.length} source files syntax-checked and scanned.`);
