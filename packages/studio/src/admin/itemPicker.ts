import type { ContentItemSummary } from '@taprootcms/core';

/**
 * Server-side helpers for the `ItemPicker` island.
 *
 * Separate from `ItemPicker.tsx` so an `.astro` page can import the constant and the mapper without
 * pulling React into its server render, and — the reason that actually matters here — so this logic
 * is reachable by the test suite. An `.astro` file's contents are not type-checked or testable; the
 * ambient shim in `astro-modules.d.ts` only makes the import resolve. That is precisely how the
 * parent picker's narrowing drifted from what `createItem` allows without anything noticing, and
 * `parentOptions.ts` was extracted for the same reason.
 */

/**
 * How many candidates travel in the prop before the control has to search for more.
 *
 * Small on purpose, now that searching reaches everything. The old numbers — 200 on the menus
 * screen, 500 for parents — were sized as though the list *was* the reachable set, so they had to be
 * large enough to contain a whole site and were still a hard ceiling past which content became
 * unlinkable. A first page only has to be big enough that a small site never has to type, which is
 * the same judgement `relationOptions.ts` makes at the same number.
 */
export const PICKER_FIRST_PAGE = 50;

export interface PickerOption {
  id: string;
  title: string;
  path: string;
  status: string;
  groupLabel?: string;
}

/** A content item summary as the picker wants it. */
export function toPickerOption(
  item: Pick<ContentItemSummary, 'id' | 'title' | 'path' | 'status'>,
  groupLabel?: string,
): PickerOption {
  return {
    id: item.id,
    title: item.title,
    path: item.path,
    status: item.status,
    ...(groupLabel ? { groupLabel } : {}),
  };
}
