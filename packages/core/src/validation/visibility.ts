import { z } from 'zod';

import type { FieldRow } from '../db/schema.js';

/**
 * Whether a field is shown, given its siblings' values.
 *
 * **One implementation, called by both sides.** The item editor decides what to render and
 * `validateItemData` decides what to require, and those two answering differently is a field an
 * editor cannot see and cannot save without. Same argument as `resolveSeo` living in core so the
 * preview and the published page cannot disagree, and `canChangeStatus` so a dropdown cannot offer
 * a status the boundary then refuses.
 *
 * Pure, with no database handle, so the editor island can run it on every keystroke.
 */

/**
 * The operators, chosen to cover what a condition is actually for rather than to be complete.
 *
 * `is_checked` is separate from `equals "true"` because a checkbox is the overwhelming case and
 * spelling it as a string comparison against a boolean is how somebody ends up writing `"false"`
 * and getting a truthy value. `is_set` / `is_empty` cover "they picked something" without needing to
 * know what, which is what a relation, a media field or a taxonomy wants.
 */
export const VISIBILITY_OPERATORS = [
  'is_checked',
  'is_not_checked',
  'equals',
  'not_equals',
  'is_set',
  'is_empty',
] as const;

export type VisibilityOperator = (typeof VISIBILITY_OPERATORS)[number];

/** Operators that read `value`; the rest ignore it, and the builder hides the input for them. */
export const OPERATORS_TAKING_VALUE: readonly VisibilityOperator[] = ['equals', 'not_equals'];

export const visibilityCondition = z.strictObject({
  /** The `api_id` of a sibling — a field at the same level, which is the only scope offered. */
  field: z.string().min(1).max(64),
  operator: z.enum(VISIBILITY_OPERATORS),
  value: z.string().max(300).optional(),
});

export type VisibilityCondition = z.infer<typeof visibilityCondition>;

/** Read a stored `visible_when`, tolerating anything unparseable as "unconditional". */
export function parseVisibility(raw: string | null | undefined): VisibilityCondition | null {
  if (!raw) return null;

  try {
    const parsed = visibilityCondition.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    // Same tolerance `parseJson` applies to every other stored blob: a malformed condition costs
    // the condition, not the field. Failing the other way would make a field unreachable with no
    // screen able to explain why.
    return null;
  }
}

/**
 * Is this value "set"?
 *
 * `false` counts as set, which is the point of asking separately from `is_checked` — an unticked
 * checkbox has an answer. An empty array does not: `media` and `relation` store `[]` for "none
 * chosen", and treating that as an answer would make `is_set` true for every multi-value field the
 * moment it was rendered.
 */
function isSet(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Compare against the author's string.
 *
 * Arrays match if any member matches, because a multi-value `select` or `taxonomy` stores a list and
 * "equals Arts" plainly means "is one of these". Everything else is compared as a string so the
 * builder can offer one text input rather than a typed one per field type — `String(3)` and
 * `String(true)` are what an author types anyway.
 */
function matches(value: unknown, expected: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => matches(entry, expected));
  if (value === undefined || value === null) return false;
  return String(value) === expected;
}

/**
 * Evaluate one condition against the sibling values at the same level.
 *
 * `known` is the set of sibling `api_id`s **from the schema**, and it is what makes a dangling
 * condition fail *open*. Without it, a condition naming a field somebody has since deleted or
 * renamed reads its value as `undefined`, `is_checked` answers false, and the dependent field is
 * hidden permanently with nothing on any screen able to say why — a content-type edit quietly
 * making an input unreachable. Absent data on a field that *does* exist is a different thing and is
 * evaluated normally: a checkbox nobody has ticked is unticked, not unknown.
 */
export function evaluateVisibility(
  condition: VisibilityCondition,
  siblings: Record<string, unknown>,
  known?: ReadonlySet<string>,
): boolean {
  if (known && !known.has(condition.field)) return true;

  const value = siblings[condition.field];

  switch (condition.operator) {
    case 'is_checked':
      return value === true;
    case 'is_not_checked':
      return value !== true;
    case 'equals':
      return matches(value, condition.value ?? '');
    case 'not_equals':
      return !matches(value, condition.value ?? '');
    case 'is_set':
      return isSet(value);
    case 'is_empty':
      return !isSet(value);
    default: {
      const exhaustive: never = condition.operator;
      return Boolean(exhaustive);
    }
  }
}

/**
 * Whether one field is shown, given the fields it sits beside and their current values.
 *
 * "Beside" is always the same level and deliberately nothing wider: a top-level field sees the
 * item's data, a block's field sees that block's `data`, a repeater sub-field sees that row's
 * `data`. That scope costs nothing to enforce because every walk already has exactly it in hand —
 * `validateBlocks` recurses with the block's own fields and data, `validateRepeater` with the row's
 * — and a condition reaching across levels would have to name a path, which is a different feature
 * with a different builder.
 */
export function isFieldVisible(
  field: FieldRow,
  siblings: FieldRow[],
  data: Record<string, unknown>,
): boolean {
  const condition = parseVisibility(field.visible_when);
  if (!condition) return true;

  return evaluateVisibility(
    condition,
    data,
    new Set(siblings.map((sibling) => sibling.api_id)),
  );
}

/** Does this field have a condition at all? Read by typegen, which must emit it optional. */
export function fieldIsConditional(field: FieldRow): boolean {
  return parseVisibility(field.visible_when) !== null;
}
