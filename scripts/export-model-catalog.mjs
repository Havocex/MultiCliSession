import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const response = await fetch('http://127.0.0.1:3001/api/chat/options');
if (!response.ok) {
  throw new Error(`Could not read provider catalog (${response.status}).`);
}

const options = await response.json();
const generatedAt = new Date().toISOString();
const lines = [
  '# Live provider model catalog',
  '',
  `Generated: ${generatedAt}`,
  '',
  'This file is generated from the local subscription-backed CLI catalogs.',
  '',
];

for (const provider of options.providers) {
  lines.push(
    `## ${provider.label}`,
    '',
    `- CLI: ${provider.session.version ?? 'not detected'}`,
    `- Connected: ${provider.session.connected ? 'yes' : 'no'}`,
    `- Catalog source: ${provider.modelsSource}`,
    `- Models: ${provider.models.length}`,
    '',
    '| Group | Model ID | Label | Effort levels | Fast |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const model of provider.models) {
    const safe = (value) => String(value ?? '').replaceAll('|', '\\|');
    lines.push(
      `| ${safe(model.group ?? 'Models')} | \`${safe(model.id)}\` | ${safe(model.label)} | ${
        model.efforts?.length ? safe(model.efforts.join(', ')) : 'preset / n/a'
      } | ${model.supportsFast ? 'yes' : 'no'} |`,
    );
  }
  lines.push('');
}

const docsDir = path.resolve('Docs');
await mkdir(docsDir, { recursive: true });
const target = path.join(docsDir, 'MODEL_CATALOG.md');
await writeFile(target, `${lines.join('\n')}\n`, 'utf8');
console.log(target);
