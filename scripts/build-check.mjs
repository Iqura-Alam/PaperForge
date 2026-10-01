import { readFile } from 'node:fs/promises';
const required = ['index.html', 'styles.css', 'src/state.js', 'src/app.js', 'src/pipeline.mjs', 'src/server.mjs'];
for (const file of required) {
  const content = await readFile(file, 'utf8');
  if (!content.trim()) throw new Error(`${file} is empty`);
}
console.log(`Build check passed: ${required.length} required files present.`);
