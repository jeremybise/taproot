import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Generate the icon path data the server-rendered admin screens draw from.
 *
 * `Icon.astro` used to carry five Lucide glyphs transcribed by hand, with a comment saying to keep
 * the list short because it "exists because a few Astro components need icons, not as a general icon
 * system". The sidebar and the Settings hub need about twenty, which is past the point where hand
 * transcription is a good trade — it is mechanical work whose failure mode is a mark that silently
 * differs from the same icon rendered by `lucide-react` in an island.
 *
 * ## Why generate rather than import at runtime
 *
 * The islands use `lucide-react`, which is React and therefore unavailable in an `.astro` file. The
 * raw geometry *is* reachable — each `lucide-react/dist/esm/icons/*.mjs` exports `__iconNode`
 * alongside its component — but `lucide-react` publishes **no `exports` map**, so those paths are
 * internal layout rather than a contract. Depending on them at runtime means a patch release can
 * break every admin screen.
 *
 * So this reads them once, at development time, and writes a checked-in module. Runtime depends on
 * nothing but our own file, the geometry cannot drift from the icons the islands draw, and the
 * generated output is reviewable in a diff. Same argument `a11y-contrast.mjs` loses by hand-mirroring
 * the `@theme` block, applied where the mirroring can be automated.
 *
 *   node scripts/build-icons.mjs
 *
 * Re-run it after adding a name to `ICONS` below. It is not wired into a build step on purpose:
 * generated output that regenerates on every install is output nobody reads.
 */

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));

const OUT = join(HERE, '..', 'packages', 'studio', 'src', 'admin', 'components', 'iconPaths.ts');

/**
 * The curated set, by Lucide name.
 *
 * Deliberately a list rather than "all of Lucide": every entry costs bytes in the admin's HTML on
 * every page, and an icon picker offering sixteen hundred glyphs is a worse control than one
 * offering twenty sensible ones. Names are Lucide's own, so an author can look one up.
 */
const ICONS = [
  // Already used by the existing Icon.astro call sites — kept so nothing regresses.
  'eye',
  'history',
  'link-2',
  'trash-2',
  'x',

  // Fixed navigation destinations.
  'layout-dashboard',
  'search',
  'image',
  'blocks',
  'tags',
  'menu',
  'settings',
  'rocket',
  'accessibility',
  'list',
  'braces',

  // Settings hub groups and cards.
  'database',
  'shapes',
  'palette',
  'signpost',
  'users',
  'key-round',
  'scroll-text',
  'server',

  // Offered to content types as their sidebar mark.
  'file-text',
  'calendar',
  'newspaper',
  'graduation-cap',
  'briefcase',
  'building-2',
  'book-open',
  'megaphone',
  'map-pin',
  'phone',
  'star',
  'folder',
  'user',
  'clipboard-list',
  'award',
];

/**
 * Lucide ships kebab-case module names; `__iconNode` is exported beside the component.
 *
 * Some names are **aliases** — `history.mjs` is nothing but
 * `export { default } from './rotate-ccw-clock.mjs'`, so it has no `__iconNode` of its own. Followed
 * rather than resolved by hard-coding the canonical names, because which names are aliases is
 * Lucide's business and changes between releases; a hard-coded map would go stale silently and this
 * cannot.
 */
async function iconNode(name, seen = new Set()) {
  if (seen.has(name)) throw new Error(`lucide-react alias loop reaching ${name}`);
  seen.add(name);

  const path = require.resolve(`lucide-react/dist/esm/icons/${name}.mjs`);
  const module = await import(`file://${path.replace(/\\/g, '/')}`);
  if (module.__iconNode) return module.__iconNode;

  const source = await readFile(path, 'utf8');
  const alias = source.match(/export\s*\{\s*default\s*\}\s*from\s*'\.\/([a-z0-9-]+)\.mjs'/);
  if (alias) return iconNode(alias[1], seen);

  throw new Error(`lucide-react's ${name}.mjs exports neither __iconNode nor a followable alias`);
}

/**
 * SVG elements `Icon.astro` can draw, and the attributes each carries.
 *
 * Lucide draws about a third of its set with something other than `<path>` — `eye` is a path plus a
 * `<circle>`, and restricting to paths would have quietly excluded a lot of the obvious choices. The
 * list is closed rather than passed through, so a new element type is a loud failure here at
 * generation time rather than a mark that renders as a fragment of itself in the admin.
 *
 * `key` is dropped: it is React's reconciliation hint and means nothing in serialised SVG.
 */
const ELEMENTS = {
  path: ['d'],
  circle: ['cx', 'cy', 'r'],
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
  line: ['x1', 'y1', 'x2', 'y2'],
  polyline: ['points'],
  polygon: ['points'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
};

const entries = [];
for (const name of ICONS) {
  const node = await iconNode(name);

  const shapes = [];
  for (const [element, attrs] of node) {
    const allowed = ELEMENTS[element];
    if (!allowed) {
      throw new Error(
        `"${name}" is drawn with <${element}>, which Icon.astro does not render. Pick another ` +
          `icon, or add that element to ELEMENTS here and to Icon.astro.`,
      );
    }
    const kept = {};
    for (const attr of allowed) {
      if (attrs?.[attr] !== undefined) kept[attr] = String(attrs[attr]);
    }
    shapes.push([element, kept]);
  }
  entries.push([name, shapes]);
}

const version = JSON.parse(await readFile(require.resolve('lucide-react/package.json'), 'utf8')).version;

const body = `/**
 * Lucide path data for the server-rendered admin screens. **Generated — do not edit.**
 *
 * Written by \`scripts/build-icons.mjs\` from lucide-react ${version}. Add a name to \`ICONS\` there
 * and re-run it; editing this file by hand puts a mark here that differs from the same icon drawn by
 * \`lucide-react\` in an island, which is the drift the generator exists to prevent.
 */

export interface IconShape {
  /** SVG element name. Closed set — see ELEMENTS in the generator. */
  tag: string;
  /** Geometry attributes, already stringified. */
  attrs: Record<string, string>;
}

export const ICON_PATHS = {
${entries
  .map(
    ([name, shapes]) =>
      `  '${name}': [\n${shapes
        .map(
          ([tag, attrs]) =>
            `    { tag: '${tag}', attrs: { ${Object.entries(attrs)
              .map(([k, v]) => `'${k}': '${String(v).replace(/'/g, "\\'")}'`)
              .join(', ')} } },`,
        )
        .join('\n')}\n  ],`,
  )
  .join('\n')}
} as const satisfies Record<string, readonly IconShape[]>;

export type IconName = keyof typeof ICON_PATHS;

export const ICON_NAMES = Object.keys(ICON_PATHS) as IconName[];

/**
 * Whether a stored string names an icon this build knows.
 *
 * \`content_types.icon\` holds a name chosen on another screen, possibly years earlier, so this is a
 * stored value that can outlive the set it names. Callers **fail open** — render the default mark —
 * for the reason a query field's missing \`dateFieldApiId\` drops its bound rather than erroring: a
 * live screen must not break for a configuration choice made elsewhere.
 */
export function isIconName(value: unknown): value is IconName {
  return typeof value === 'string' && Object.hasOwn(ICON_PATHS, value);
}
`;

await writeFile(OUT, body, 'utf8');
console.log(`Wrote ${entries.length} icons to ${OUT.replace(process.cwd(), '.')} (lucide-react ${version}).`);
