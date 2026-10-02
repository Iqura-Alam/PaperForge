import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
const required = ['index.html', 'styles.css', 'src/state.js', 'src/app.js', 'src/pipeline.mjs', 'src/server.mjs'];
for (const file of required) {
  const content = await readFile(file, 'utf8');
  if (!content.trim()) throw new Error(`${file} is empty`);
}
for (const file of required.filter((file) => /\.(?:m?js)$/.test(file))) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${file} failed syntax validation:\n${result.stderr || result.stdout}`);
  }
}
console.log(`Build check passed: ${required.length} required files present and source syntax is valid.`);
