import type { FieldRow } from '../db/schema.js';
import { MAX_BLOCK_DEPTH, repeaterRowFields, type BlockInstance } from '../validation/fields.js';
import { isFieldVisible } from '../validation/visibility.js';
import { htmlToText, tokenize } from './sanitizeHtml.js';

/**
 * The content accessibility checker.
 *
 * **What it is not.** This audits *published content* — what a visitor receives. The WCAG
 * compliance of the admin itself is a different job, checked by `npm run a11y`, and the two must
 * not be confused: an editor can write an inaccessible page in a perfectly accessible editor.
 *
 * **Advisory, never blocking.** Nothing here runs in a write path and nothing here refuses a save
 * or a publish. That is deliberate rather than a first step: an author who cannot publish because a
 * checker disagrees with them routes around the CMS, and a false positive in a rule would become an
 * outage. `validateItemData` is where a rule that must hold goes; this is where a rule that should
 * usually hold goes, and mixing the two is how "advisory" quietly stops being advisory.
 *
 * **Pure, with no database handle**, for the same reason `resolveSeo` is: the editor's live panel
 * and the site-wide report must not drift, and one of those two callers is a React island running
 * on every keystroke. Everything it needs to resolve — alt text, block type schemas, reusable block
 * content — arrives in `A11yContext`, looked up by whoever has the connection.
 */

export type A11yRule =
  | 'image-alt'
  | 'heading-order'
  | 'link-name'
  | 'link-text'
  | 'embed-name'
  | 'embed-title';

export type A11ySeverity = 'error' | 'warning';

export interface A11yIssue {
  rule: A11yRule;
  severity: A11ySeverity;
  /** Written for the person who has to fix it, so it says what to do rather than what is wrong. */
  message: string;
  /**
   * The **top-level** field this came from, however deeply nested the value was.
   *
   * That is what the editor can actually scroll to: a block three levels down has no control of its
   * own on the page, but the block field holding it does. `location` carries the rest of the trail.
   */
  fieldApiId: string;
  /** Human trail to the value, e.g. `Body → Block 2 (Hero) → Heading`. */
  location: string;
  /**
   * Set when the issue belongs to a reusable block rather than to this item.
   *
   * A referenced block carries no content of its own — the library row owns it — so the page's
   * author cannot fix this here, and telling them to would be sending them to the wrong screen.
   */
  inheritedFrom?: { id: string; name: string };
}

/** One media asset, as much of it as a rule needs. */
export interface A11yMediaInfo {
  filename: string;
  mimeType: string;
  /**
   * `null` means nobody has said. `''` means somebody said it is decorative.
   *
   * The distinction is the whole reason `image-alt` is usable: without it every divider, icon, and
   * background flourish is a permanent complaint, and a panel that is always red is a panel nobody
   * reads.
   */
  altText: string | null;
}

/**
 * Whether an asset should be reported as undescribed.
 *
 * One function because four places ask: this checker, the media library's banner and cards, the
 * picker, and the media field. They used to ask it as `!altText`, which is also true of `''` — so
 * the moment `''` came to mean "decorative", every one of them would have gone on calling a
 * deliberately undescribed image a mistake.
 */
export function needsAltText(asset: { mimeType: string; altText: string | null }): boolean {
  return asset.mimeType.startsWith('image/') && asset.altText === null;
}

export interface A11yContext {
  /**
   * Alt text for the media this item references, keyed by id.
   *
   * An id **absent** from the map is not reported. The map is built by querying for exactly the ids
   * in the item's data, so a missing one is an asset whose row is gone — a broken reference, which
   * is a different problem, and "this image has no alt text" would send somebody to fix a screen
   * that no longer exists. Omitting the map entirely means no image can be checked, which is the
   * honest answer for a caller that did not resolve any.
   */
  altById?: Map<string, A11yMediaInfo>;
  /** Block type schemas keyed by `api_id`, as `blockTypeRegistry` returns them, plus a name. */
  blockTypes?: Map<string, { name: string; fields: FieldRow[] }>;
  /** Library entries keyed by id, for blocks placed by reference. */
  reusableBlocks?: Map<string, { id: string; name: string; type: string; data: Record<string, unknown> }>;
}

export interface A11yRuleMeta {
  rule: A11yRule;
  label: string;
  /** One line, in an editor's vocabulary — it is a filter's explanation, not a spec. */
  description: string;
  /**
   * No `severity` here on purpose. Every issue already carries its own, and a second copy keyed by
   * rule is a second place for the answer to live — the shape that let `status.ts` carry a
   * `needsPublish` flag which read correctly, was tested, and was enforced by nothing.
   */
}

/**
 * The rules, in the order a report should list them.
 *
 * Here rather than in the admin for the same reason `FIELD_TYPE_META` is: the report's filter names
 * them and so does the handbook, and a copy in the admin is a copy free to go on describing a rule
 * that no longer works that way.
 */
export const A11Y_RULE_META: Record<A11yRule, A11yRuleMeta> = {
  'image-alt': {
    rule: 'image-alt',
    label: 'Missing alt text',
    description: 'An image nobody has described, and nobody has marked decorative.',
  },
  'heading-order': {
    rule: 'heading-order',
    label: 'Heading order',
    description: 'Headings that skip a level, or start deeper than level 2.',
  },
  'link-name': {
    rule: 'link-name',
    label: 'Link with no text',
    description: 'A link announced as nothing but the word “link”.',
  },
  'link-text': {
    rule: 'link-text',
    label: 'Unhelpful link text',
    description: '“Click here”, “read more”, or a bare URL — text that does not say where it goes.',
  },
  'embed-name': {
    rule: 'embed-name',
    label: 'Embed with no title',
    description: 'A framed video, map or form announced as nothing but “iframe”.',
  },
  'embed-title': {
    rule: 'embed-title',
    label: 'Unhelpful embed title',
    description: '“Video”, “Map” — a title naming the kind of thing rather than this one.',
  },
};

export const A11Y_RULES = Object.keys(A11Y_RULE_META) as A11yRule[];

export function isA11yRule(value: string): value is A11yRule {
  return Object.hasOwn(A11Y_RULE_META, value);
}

/**
 * Every accessibility issue in one content item's field values.
 *
 * The walk mirrors `validateItemData`'s exactly — top-level fields, blocks through the registry
 * bounded by `MAX_BLOCK_DEPTH`, repeater rows through `repeaterRowFields` — because a value that
 * validation reaches and this does not is a value nobody is checking.
 */
export function checkItemAccessibility(
  fields: FieldRow[],
  data: Record<string, unknown>,
  context: A11yContext = {},
): A11yIssue[] {
  const issues: A11yIssue[] = [];

  for (const field of fields) {
    if (!isFieldVisible(field, fields, data)) continue;

    walkField(field, data[field.api_id], context, {
      issues,
      fieldApiId: field.api_id,
      trail: [],
      blockDepth: MAX_BLOCK_DEPTH,
    });
  }

  return issues;
}

interface WalkState {
  issues: A11yIssue[];
  /** Fixed at the top level and carried all the way down — see `A11yIssue.fieldApiId`. */
  fieldApiId: string;
  /** Location segments accumulated so far, outermost first. */
  trail: string[];
  blockDepth: number;
  inheritedFrom?: { id: string; name: string };
}

function walkField(field: FieldRow, value: unknown, context: A11yContext, state: WalkState): void {
  const here = [...state.trail, field.label];

  switch (field.type) {
    case 'richtext': {
      if (typeof value !== 'string' || !value) return;
      for (const found of checkRichText(value)) {
        state.issues.push(toIssue(found, state, here));
      }
      return;
    }

    case 'media': {
      for (const id of mediaIds(value)) {
        const asset = context.altById?.get(id);
        // See `A11yContext.altById` — an unresolvable id is a broken reference, not a missing
        // description, and reporting it here would send somebody to the wrong screen.
        if (!asset) continue;
        if (!needsAltText(asset)) continue;

        state.issues.push(
          toIssue(
            {
              rule: 'image-alt',
              severity: 'error',
              message: `“${asset.filename}” has no alt text. Describe what the image shows, or mark it decorative in the media library.`,
            },
            state,
            here,
          ),
        );
      }
      return;
    }

    case 'block': {
      if (!Array.isArray(value)) return;
      walkBlocks(value as BlockInstance[], context, { ...state, trail: here });
      return;
    }

    case 'repeater': {
      if (!Array.isArray(value)) return;
      const subFields = repeaterRowFields(field);
      if (subFields.length === 0) return;

      /**
       * No depth bound needed, unlike blocks: `REPEATER_SUB_FIELD_TYPES` excludes `repeater` and
       * `block`, so a row's fields are all leaves and this recursion is exactly one level deep.
       */
      value.forEach((row, index) => {
        if (typeof row !== 'object' || row === null) return;
        const rowData = (row as { data?: unknown }).data;
        if (typeof rowData !== 'object' || rowData === null) return;

        for (const sub of subFields) {
          const row = rowData as Record<string, unknown>;
          if (!isFieldVisible(sub, subFields, row)) continue;

          walkField(sub, row[sub.api_id], context, {
            ...state,
            trail: [...here, `Entry ${index + 1}`],
          });
        }
      });
      return;
    }

    /**
     * A link's label is link text, and the rules for it already exist.
     *
     * "Read more" is exactly as useless on a button as it is in a paragraph — a screen reader can
     * list a page's links on their own, and out of that list this one says nothing (WCAG 2.4.4). So
     * this reuses `checkLinkText` rather than growing a second opinion about generic wording.
     *
     * A *missing* label is not reported. It is legitimate — a site may render the target's own
     * title, which is what the slider case does — and a rule cannot tell that apart from an
     * omission without knowing a template this CMS deliberately does not ship.
     */
    case 'link': {
      if (typeof value !== 'object' || value === null) return;
      const label = (value as { label?: unknown }).label;
      if (typeof label !== 'string' || label.trim() === '') return;

      for (const found of checkLinkText(label)) {
        state.issues.push(toIssue(found, state, here));
      }
      return;
    }

    // text, number, boolean, date, select, taxonomy, relation — nothing an accessibility rule
    // reads. Listed rather than defaulted so a new field type has to be considered here.
    case 'text':
    case 'number':
    case 'boolean':
    case 'date':
    case 'select':
    case 'taxonomy':
    case 'relation':
    /*
     * A snippet field names a shared value; whatever that value says is checked where it is written,
     * not on every page that points at it. Reporting it here would accuse each of a dozen pages of
     * the same problem and send their authors to a screen they may not be able to edit — which is
     * the reasoning the `query` case below already gives for not following its results.
     */
    case 'snippet':
      return;

    /**
     * A query holds a rule, and a rule has no alt text and no headings.
     *
     * Its *results* do, and they are deliberately not checked here: they are other content items,
     * each already reported on its own editing screen and in the site-wide report. Following the
     * query would attribute somebody else's missing alt text to whoever placed the listing block —
     * pointing them at a fix they may have no permission to make — and would make this walk's cost
     * depend on how many items happen to match, on a function that runs on every keystroke.
     */
    case 'query':
      return;

    /**
     * An embed's title is the frame's accessible name, and it is the whole rule.
     *
     * `validateItemData` already requires it, so on the ordinary path this reports nothing — which
     * is the right relationship between the two layers rather than a redundancy. What reaches here
     * is what validation deliberately let through: a preview snapshot saved under
     * `requireComplete: false`, and any item stored before the field required one. Both render a
     * frame announced as “iframe” and nothing else (WCAG 4.1.2, 2.4.1), and the advisory panel is
     * where an author finds out without being blocked from saving.
     *
     * A *generic* title is the half validation cannot take: “Video” parses, satisfies every
     * minimum, and tells somebody listing a page's frames exactly nothing.
     */
    case 'embed': {
      if (typeof value !== 'object' || value === null) return;
      const title = (value as { title?: unknown }).title;

      for (const found of checkEmbedTitle(typeof title === 'string' ? title : '')) {
        state.issues.push(toIssue(found, state, here));
      }
      return;
    }

    default: {
      const exhaustive: never = field.type;
      throw new Error(`Unhandled field type: ${String(exhaustive)}`);
    }
  }
}

function walkBlocks(blocks: BlockInstance[], context: A11yContext, state: WalkState): void {
  if (state.blockDepth <= 0) return;

  blocks.forEach((block, index) => {
    if (typeof block !== 'object' || block === null) return;

    /**
     * A reference is checked against the library entry's content, and attributed to it.
     *
     * The page stores `{ id, type, ref }` and no copy, so there is nothing here to check otherwise;
     * and once the entry is what was checked, the entry is who should be named — the fix happens in
     * the library, on a screen this page's author may not even have open.
     */
    if (block.ref) {
      const entry = context.reusableBlocks?.get(block.ref);
      if (!entry) return;

      const blockType = context.blockTypes?.get(entry.type);
      if (!blockType) return;

      for (const field of blockType.fields) {
        if (!isFieldVisible(field, blockType.fields, entry.data)) continue;

        walkField(field, entry.data[field.api_id], context, {
          ...state,
          trail: [...state.trail, `Block ${index + 1} (${entry.name})`],
          blockDepth: state.blockDepth - 1,
          inheritedFrom: { id: entry.id, name: entry.name },
        });
      }
      return;
    }

    const blockType = context.blockTypes?.get(block.type);
    if (!blockType) return;

    const data = block.data ?? {};
    for (const field of blockType.fields) {
      if (!isFieldVisible(field, blockType.fields, data)) continue;

      walkField(field, data[field.api_id], context, {
        ...state,
        trail: [...state.trail, `Block ${index + 1} (${blockType.name})`],
        blockDepth: state.blockDepth - 1,
      });
    }
  });
}

function toIssue(
  found: Pick<A11yIssue, 'rule' | 'severity' | 'message'>,
  state: WalkState,
  trail: string[],
): A11yIssue {
  return {
    ...found,
    fieldApiId: state.fieldApiId,
    location: trail.join(' → '),
    ...(state.inheritedFrom ? { inheritedFrom: state.inheritedFrom } : {}),
  };
}

/**
 * A media field's stored shape follows its own config — a bare id when single, an array when it
 * allows several. Reading both here rather than consulting the config keeps this a function of the
 * value, which is what a half-migrated field or a hand-written API payload actually produces.
 */
function mediaIds(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : [];
  if (Array.isArray(value)) return value.filter((id): id is string => typeof id === 'string' && !!id);
  return [];
}

// ---------------------------------------------------------------------------
// Rich text rules
// ---------------------------------------------------------------------------

const HEADING_LEVELS: Record<string, number> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
};

/**
 * Link text that describes the act of clicking rather than the destination.
 *
 * Compared after lowercasing and stripping surrounding punctuation, so “Click here!” and “click
 * here” are the same entry. Kept short on purpose — a long list starts catching legitimate phrases,
 * and a rule that cries wolf is a rule that gets ignored rather than obeyed.
 */
const GENERIC_LINK_TEXT = new Set([
  'click here',
  'here',
  'read more',
  'more',
  'learn more',
  'link',
  'this link',
  'this page',
  'download',
  'continue',
]);

/**
 * Embed titles that name the medium instead of the content.
 *
 * A separate list from `GENERIC_LINK_TEXT` rather than a reuse of it, because the two failures are
 * different sentences. Useless link text describes the *act* — "click here" — while a useless frame
 * title describes the *container*: "Video" on a page with three videos is exactly as unhelpful as
 * no title, and "click here" is not something anybody types into a title box. Sharing one list
 * would mean each rule carrying entries that cannot occur in it.
 *
 * Short for the same reason that one is: a rule that cries wolf gets ignored rather than obeyed.
 */
const GENERIC_EMBED_TITLE = new Set([
  'embed',
  'iframe',
  'video',
  'map',
  'form',
  'frame',
  'untitled',
  'youtube',
  'google map',
  'google maps',
]);

type RichTextFinding = Pick<A11yIssue, 'rule' | 'severity' | 'message'>;

/**
 * Heading order and link quality within **one** rich text value.
 *
 * The scope is the interesting part rather than a shortcut. Taproot ships no templates and has no
 * idea what order a site renders a content type's fields in — or whether it renders all of them —
 * so the document outline a visitor actually receives is not knowable here. Within one value it is
 * knowable exactly, so that is what is checked, and "why didn't it catch the h2 after my block's
 * h3" has an answer rather than a bug.
 */
export function checkRichText(html: string): RichTextFinding[] {
  const findings: RichTextFinding[] = [];

  let previousLevel = 0;
  /** Depth rather than a flag, so a stray nested `<a>` cannot end the outer one early. */
  let anchorDepth = 0;
  let anchorText: string[] = [];

  for (const token of tokenize(html)) {
    if (token.kind === 'text') {
      if (anchorDepth > 0) anchorText.push(token.value);
      continue;
    }
    if (token.kind === 'other') continue;

    if (token.kind === 'open') {
      const level = HEADING_LEVELS[token.name];
      if (level !== undefined) {
        findings.push(...checkHeadingLevel(level, previousLevel));
        previousLevel = level;
      }

      if (token.name === 'a') {
        if (anchorDepth === 0) anchorText = [];
        anchorDepth++;
      }
      continue;
    }

    if (token.name === 'a' && anchorDepth > 0) {
      anchorDepth--;
      if (anchorDepth === 0) findings.push(...checkLinkText(anchorText.join('')));
    }
  }

  // An unclosed `<a>` still wrapped text a visitor will see, so it is checked rather than dropped.
  if (anchorDepth > 0) findings.push(...checkLinkText(anchorText.join('')));

  return findings;
}

function checkHeadingLevel(level: number, previousLevel: number): RichTextFinding[] {
  /**
   * `h1` cannot reach here through any write path — the sanitiser's allowlist drops it, because a
   * page's level 1 is its title. This is the boundary's own guarantee rather than a second one:
   * content written straight into the database, or imported by a migration that skipped validation,
   * still gets an answer instead of silently passing.
   */
  if (level === 1) {
    return [
      {
        rule: 'heading-order',
        severity: 'error',
        message:
          'There is a level 1 heading in the body. A page has one level 1 heading and it is the title, so body headings start at level 2.',
      },
    ];
  }

  if (previousLevel === 0) {
    return level > 2
      ? [
          {
            rule: 'heading-order',
            severity: 'error',
            message: `The first heading here is a level ${level}. Body headings start at level 2 — the page's level 1 is its title.`,
          },
        ]
      : [];
  }

  return level > previousLevel + 1
    ? [
        {
          rule: 'heading-order',
          severity: 'error',
          message: `A level ${previousLevel} heading is followed by a level ${level}. Heading levels must not skip — people who navigate by headings hear a section that belongs to nothing.`,
        },
      ]
    : [];
}

function checkLinkText(raw: string): RichTextFinding[] {
  /**
   * `htmlToText` decodes entities and collapses whitespace, so `&nbsp;Read&nbsp;more ` compares
   * equal to `read more`. Only text tokens were collected, so there are no tags left to strip.
   */
  const text = htmlToText(raw);

  /**
   * An empty link has no accessible name at all.
   *
   * In ordinary HTML an image's alt text could supply one, which is why this is not a rule a
   * general checker could state so plainly — but `img` is absent from the richtext allowlist, so
   * inside a rich text value the visible text is the only source there is.
   */
  if (!text) {
    return [
      {
        rule: 'link-name',
        severity: 'error',
        message: 'A link here has no text, so it is announced as nothing but “link”.',
      },
    ];
  }

  const normalised = text.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

  if (GENERIC_LINK_TEXT.has(normalised)) {
    return [
      {
        rule: 'link-text',
        severity: 'warning',
        message: `“${text}” does not say where the link goes. Screen readers can list a page's links on their own, and out of that list this one reads as nothing.`,
      },
    ];
  }

  if (/^(https?:\/\/|www\.)/i.test(normalised)) {
    return [
      {
        rule: 'link-text',
        severity: 'warning',
        message: `“${text}” is a bare URL. Link the words that describe the destination instead — a URL is read out character by character.`,
      },
    ];
  }

  return [];
}

function checkEmbedTitle(raw: string): RichTextFinding[] {
  const text = raw.trim();

  if (!text) {
    return [
      {
        rule: 'embed-name',
        severity: 'error',
        message:
          'This embed has no title, so the frame is announced as nothing but “iframe”. Describe what it contains — “Campus tour video”, “Request information form”.',
      },
    ];
  }

  const normalised = text.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

  if (GENERIC_EMBED_TITLE.has(normalised)) {
    return [
      {
        rule: 'embed-title',
        severity: 'warning',
        message: `“${text}” names the kind of thing rather than this one. On a page with two of them, both are announced identically.`,
      },
    ];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Helpers the callers share
// ---------------------------------------------------------------------------

/**
 * The media ids a content item's data references, for building `A11yContext.altById`.
 *
 * Both callers need this and neither should walk the field tree twice, so it is one function using
 * the same walk as the check itself: a media field the checker reads and this misses would report
 * every one of its images as undescribed.
 */
export function referencedMediaIds(
  fields: FieldRow[],
  data: Record<string, unknown>,
  context: Pick<A11yContext, 'blockTypes' | 'reusableBlocks'> = {},
): string[] {
  const found = new Set<string>();
  collectMediaIds(fields, data, context, found, MAX_BLOCK_DEPTH);
  return [...found];
}

/**
 * **This walk deliberately does not skip conditionally hidden fields, where the rules walk does.**
 *
 * The two answer different questions and the divergence is the point. `checkItemAccessibility` asks
 * "what is on screen", so a field whose condition is unmet has nothing to report and nagging about
 * it would make the panel permanently red for content the editor has switched off. This asks "what
 * does this item point at", and a hidden field's value is still *stored* — that is the rule in
 * `validateItemData` — so an image referenced only from a hidden field still needs its alt text
 * resolved, or the panel reports every one of its images as undescribed the moment somebody
 * unticks the box above them.
 *
 * The root CLAUDE.md's note that this uses the same walk as the rules is true of the *shape* and no
 * longer of the filter. Do not "restore" the guard here.
 */
function collectMediaIds(
  fields: FieldRow[],
  data: Record<string, unknown>,
  context: Pick<A11yContext, 'blockTypes' | 'reusableBlocks'>,
  found: Set<string>,
  blockDepth: number,
): void {
  for (const field of fields) {
    const value = data[field.api_id];

    if (field.type === 'media') {
      for (const id of mediaIds(value)) found.add(id);
      continue;
    }

    if (field.type === 'block' && Array.isArray(value) && blockDepth > 0) {
      for (const block of value as BlockInstance[]) {
        if (typeof block !== 'object' || block === null) continue;

        if (block.ref) {
          const entry = context.reusableBlocks?.get(block.ref);
          const refType = entry && context.blockTypes?.get(entry.type);
          if (entry && refType) {
            collectMediaIds(refType.fields, entry.data, context, found, blockDepth - 1);
          }
          continue;
        }

        const blockType = context.blockTypes?.get(block.type);
        if (blockType) collectMediaIds(blockType.fields, block.data ?? {}, context, found, blockDepth - 1);
      }
      continue;
    }

    if (field.type === 'repeater' && Array.isArray(value)) {
      const subFields = repeaterRowFields(field);
      if (subFields.length === 0) continue;

      for (const row of value) {
        if (typeof row !== 'object' || row === null) continue;
        const rowData = (row as { data?: unknown }).data;
        if (typeof rowData !== 'object' || rowData === null) continue;
        collectMediaIds(subFields, rowData as Record<string, unknown>, context, found, blockDepth);
      }
    }
  }
}

/** How many of each severity, for a panel heading or a report row. */
export function countBySeverity(issues: A11yIssue[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const issue of issues) {
    if (issue.severity === 'error') errors++;
    else warnings++;
  }
  return { errors, warnings };
}
