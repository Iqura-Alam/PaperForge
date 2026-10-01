import { readFile } from 'node:fs/promises';
const files = ['src/state.js', 'src/app.js'];
for (const file of files) {
  const content = await readFile(file, 'utf8');
  if (content.includes('console.log')) throw new Error(`${file}: remove console.log`);
}
console.log(`Lint check passed: ${files.length} source files scanned.`);
