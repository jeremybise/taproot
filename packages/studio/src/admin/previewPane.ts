/**
 * Whether the item editor's live preview pane is open.
 *
 * A cookie read on the server, following `theme.ts` exactly, and for the same two reasons. The
 * editor's container has to be wider when the pane is open — 64rem of `#main` split two ways leaves
 * the preview narrower than the phone it is meant to be previewing — and a width decided by an
 * island after hydration is a visible jump on every page load. Stamping an attribute on `<html>`
 * before any CSS is sent is the only version with no jump, and `localStorage` cannot do that
 * because the server cannot see it.
 *
 * The alternative considered was a `?preview=1` query parameter. It would work, but `save()` does a
 * full-page navigation on every save with three different redirect targets, so the parameter would
 * have to be threaded through all of them — and a state the URL carries is a state one forgotten
 * branch drops.
 */

/**
 * Deliberately not `httpOnly`, matching `THEME_COOKIE_NAME`: the toggle writes it from the client
 * and the server reads the same value, rather than there being two sources of truth that disagree
 * after the first toggle and before the next navigation.
 */
export const PREVIEW_PANE_COOKIE_NAME = 'taproot_preview_pane';

export type PreviewPaneState = 'open' | 'closed';

/**
 * What a stored cookie value means.
 *
 * Anything unrecognised is `closed` — no cookie, a stale value, something hand-edited. The failure
 * mode of a bad value is the editor as it was before this feature existed, which is the same
 * principle `resolveTheme` follows.
 */
export function resolvePreviewPane(cookieValue: string | undefined): PreviewPaneState {
  return cookieValue === 'open' ? 'open' : 'closed';
}

/**
 * The `data-preview` value for `<html>`, or `undefined` to leave the attribute off.
 *
 * `closed` renders no attribute rather than `data-preview="closed"`, so "never opened it" and
 * "closed it" are one state rather than two that can drift — the same argument that keeps `system`
 * from being written as a theme attribute.
 */
export function previewPaneAttribute(state: PreviewPaneState): 'open' | undefined {
  return state === 'open' ? 'open' : undefined;
}
