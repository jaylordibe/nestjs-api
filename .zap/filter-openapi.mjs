// Usage: node .zap/filter-openapi.mjs <in.json> <out.json>
//
// Writes the OpenAPI document the ZAP scan runs against: the app's own
// document minus the operations in session-ending-operations.json. Fails if a
// listed operation is missing, so a renamed route cannot silently drop out of
// the exclusion and start ending the scan's session again.
import { readFileSync, writeFileSync } from 'node:fs';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error('usage: filter-openapi.mjs <in.json> <out.json>');
  process.exit(2);
}

const document = JSON.parse(readFileSync(inputPath, 'utf8'));
const { operations } = JSON.parse(
  readFileSync(new URL('./session-ending-operations.json', import.meta.url), 'utf8'),
);

for (const { method, path } of operations) {
  const pathItem = document.paths?.[path];
  if (!pathItem?.[method]) {
    console.error(`filter-openapi: ${method.toUpperCase()} ${path} is not in the document — update .zap/session-ending-operations.json`);
    process.exit(1);
  }
  delete pathItem[method];
  if (!Object.keys(pathItem).some((key) => ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'].includes(key))) {
    delete document.paths[path];
  }
  console.log(`filter-openapi: excluded ${method.toUpperCase()} ${path}`);
}

writeFileSync(outputPath, JSON.stringify(document));
