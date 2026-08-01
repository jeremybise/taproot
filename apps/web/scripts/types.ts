import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { generateTypes, type DeliverySchema } from '@taprootcms/core';

import { loadEnv } from './_env.ts';

/**
 * Generate TypeScript for this site's content model.
 *
 * Reads the **delivery API over HTTP**, not the database, and that is the point rather than an
 * inconvenience: it exercises the same contract a consumer uses, so the generated types describe
 * what a site actually receives. A generator that read the database directly would keep working
 * long after the endpoint it claims to describe had drifted.
 *
 *   npm run taproot:types                      # against a local dev server
 *   TAPROOT_API_URL=… TAPROOT_API_KEY=… npm run taproot:types
 *
 * The output is checked in on purpose. A schema change should show up as a reviewable diff, and the
 * moment somebody renames a field the templates that used it stop compiling.
 */

loadEnv();

const base = (process.env.TAPROOT_API_URL ?? 'http://localhost:4321').replace(/\/$/, '');
const key = process.env.TAPROOT_API_KEY;
const out = resolve(import.meta.dirname, '../src/content.d.ts');

const headers: Record<string, string> = {};
if (key) headers.authorization = `Bearer ${key}`;

const url = `${base}/api/taproot/delivery/schema`;
const response = await fetch(url, { headers });

if (response.status === 401) {
  console.error(
    `\n  ${url} refused the request.\n\n` +
      '  The delivery API needs an API key with the content:read scope. Create one under\n' +
      '  Settings → API keys, then set TAPROOT_API_KEY. Against a local dev server you can\n' +
      '  instead sign in and copy a session, but a key is what a real deployment uses.\n',
  );
  process.exit(1);
}

if (!response.ok) {
  console.error(`\n  ${url} answered ${response.status}.\n`);
  process.exit(1);
}

const schema = (await response.json()) as DeliverySchema;

await writeFile(out, generateTypes(schema, { source: url }), 'utf8');

const fieldCount = [...schema.contentTypes, ...schema.blockTypes].reduce(
  (total, type) => total + type.fields.length,
  0,
);

console.log(
  `Wrote ${out}\n  ${schema.contentTypes.length} content type(s), ` +
    `${schema.blockTypes.length} block type(s), ${fieldCount} field(s).`,
);
