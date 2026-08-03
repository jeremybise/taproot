# @taprootcms/studio — admin accessibility

Guidance for Claude Code working in `packages/studio`. See the repository root
[CLAUDE.md](../../CLAUDE.md) for everything that applies across Taproot — including the standing
rule that the admin must be WCAG 2.1 AA and `npm run a11y` must pass before a phase is called done.
This file holds the implementation detail behind that rule. Paths below are relative to the
repository root.

**The admin is responsive, and WCAG 1.4.10 Reflow is why it has to be.** Reflow is Level **AA** —
usable at a width equivalent to 320 CSS px with no scrolling in two dimensions — so it is part of the
bar the root file already sets, not a nice-to-have. It went unmet for four phases because nothing
could see it: jsdom computes no layout, and `a11y-audit.mjs` does not pass `resources: 'usable'`, so
it never loads the stylesheet at all and every Tailwind class is an inert string to it. Verified by
measuring `scrollingElement.scrollWidth` in a real browser across 11 routes × 5 widths.
- **The nav is one element that is sometimes a drawer.** Below `lg` `.taproot-nav` slides off-canvas,
  toggled by `data-nav` on `<html>` — the third use of that pattern after `data-theme` and
  `data-preview`, but with **no cookie**: every admin link is a real page load, so a drawer that
  remembered being open would reopen on arrival. Two elements (desktop sidebar + duplicate drawer)
  would put two `<nav aria-label="Main">` landmarks in the DOM, and the audit sees both because
  `hidden lg:block` means nothing without CSS. Not a `<dialog>` either: forced visible at desktop it
  keeps `role="dialog"` and the sidebar announces itself as one on every page. The cost is
  hand-written focus handling, and **`inert` on `#admin-content` is the part that must not be
  dropped** — without it, tabbing past the last nav link walks invisibly through the page behind.
- **The small-screen top bar lives *inside* the banner `<header>`.** It was a top-level `<div>` for
  one run of `npm run a11y`, which failed 29 routes on axe's `region` rule. A second `<header>` is
  not the fix — two banner landmarks is its own violation.
- **Two defects here were invisible to inspection and only measurement found them**, which is the
  argument for the manual pass:
  - a grid child missing `min-w-0` (`min-width: auto` is the default, and it refuses to shrink
    below its content) sized the item editor's sidebar column to its widest child;
  - **visually hidden text escaped a scroll container.** `.sr-only-focusable` hides with
    `position: absolute`, and an absolutely positioned element whose containing block is the
    viewport is *not* clipped by an `overflow-x: auto` ancestor — so a 1px `<span>` inside a 753px
    table laid out at x=741 and dragged the page 437px sideways while the table itself scrolled
    correctly. `[class~='overflow-x-auto'] { position: relative }` in `admin.css` is the fix.
- **`reflowHazards()` in `a11y-audit.mjs` is narrow on purpose.** A first draft also flagged every
  `min-w-56`, every unprefixed `grid-cols-2`, and the sidebar's `w-60` — measurement showed all three
  were fine, so they were removed. **A check that fires on verified-good markup is one somebody
  switches off.** It cannot prove reflow; neither of the two defects above is detectable from class
  strings. Opt out with `data-reflow-ok="why"`.
- **The sidebar's `sticky` lives on `#admin-nav`, not on the column inside it.** A sticky element
  only travels within its containing block, and the inner column is exactly as tall as its wrapper —
  so moving the sticky onto a child broke it silently and the sidebar scrolled away on any long page.
  It worked before only because that child was a direct flex item of the shell and stretched to the
  full page height.
- **Container queries are used in exactly three places**, all field-level grids. The general
  "breakpoints measure the viewport, not the column" problem dissolves once the sidebar collapses;
  what does not is the item editor's 26rem rail at a ≥1280px viewport, where a `sm:` grid fires on a
  416px column. `@sm:` needs an `@container` ancestor in the same component — without one it never
  matches and the grid is silently stuck at one column.

**Sticky positioning needs a containing block taller than the sticky element — this has now bitten
three times.** The sidebar column, the small-screen top bar, and the preview pane each looked correct
and each silently did nothing, because a sticky element travels only inside its containing block and
in every case that block was exactly the element's own height. The top bar is `position: fixed`
because of it. When adding anything sticky, check what its parent's height actually is, and verify by
scrolling in a browser rather than by reading the CSS.

**`--admin-topbar-h` is the one number three things read.** It is the small-screen bar's height, the
top padding that keeps `#admin-content` clear of it, and the offset every sticky `PageHeader` starts
at. It is **measured, not computed** — a value derived from the padding classes was 3px short and
left a sliver of scrolling content visible above the header.

**One sticky bar per screen.** `PageHeader.astro` is it for screens whose actions are server-rendered;
the item editor is the exception, where the island owns the bar because Save is React state (`busy`,
a changing label) that a server-rendered header cannot drive. That is why the icon actions live in
`EditorActionIcons.tsx` rather than an Astro component, and why `Sheet.astro` delegates from the
document: it used to bind every `[data-sheet-open]` it could find at load, which is a list that never
includes anything React renders afterwards.

**Disclosure menus, not `role="menu"`, and two implementations on purpose.** `UserMenu.astro` drives
Astro-rendered `[data-menu]` panels with a delegated script; `useDismissable.ts` does the same job for
React-rendered ones. The split is not laziness — React owns the DOM it renders, so a script toggling
`hidden` on a React panel loses it on the next re-render. Both implement one contract:
`aria-expanded`, Escape, click-outside, focus back to the trigger. Change one, change the other. Both
Escape handlers guard on their own state so they do not fight the navigation drawer's.

**The audit opens what the UI hides.** `scripts/a11y-audit.mjs` force-opens `dialog.taproot-sheet`
*and* `[data-menu-panel]` before running axe, because a closed one is `display: none` and axe skips
it — a run would stay green while the account link, the theme buttons and sign-out quietly stopped
being checked.

**`primaryTransition` decides which status action is promoted, and lives beside the transition
table.** The editor shows one named button plus a "More" disclosure rather than four full-width
buttons. The old comment argued against a status `<select>` and was right about what it defended —
the label reads "Submit for review", never "in_review" — and that is unchanged. `published`
deliberately has no primary: everything reachable from a live page is unusual, and the usual reason
to open one is to edit it and press Save.

**Source files are UTF-8 and `sourceEncoding.test.ts` keeps them that way.** Two files were once
saved through a Windows-1252 misdecode and shipped `â†‘` for an arrow and `â€œ` for a quote for four
phases. They were *valid* UTF-8 the whole time — just the wrong characters — so nothing at runtime
could catch it, and `BlockListEditor.test.tsx` renders those exact buttons but asserts on their
`aria-label`, never their glyph. Scan for the character signature, not for double-encoded bytes: the
byte scan is the obvious thing to write and finds nothing at all.

**A new colour token is not done until it has a pair in `a11y-contrast.mjs`.** The script mirrors
the `@theme` blocks by hand — jsdom resolves no custom properties, so there is no way to derive
them — which means a token added to the CSS alone is simply unchecked. The same applies to a new
*pairing* of existing tokens: `axe` runs with `color-contrast` disabled precisely because this
script is the authority, so a colour put on a background it has never been checked against is
unchecked no matter how many routes pass. The accent went four phases with two unchecked pairs for
exactly that reason — it is the colour rich-text links are drawn in, and the token had only ever
been thought of as a button background.

**The accent is configurable, so `branding/color.ts` is a second hand-mirror of the same `@theme`
block.** Two copies is one more than ideal and the alternative was checking the accent's pairs
nowhere: the settings screen has to report contrast for a colour that does not exist until somebody
types it, which no static script can do. `ADMIN_PALETTE` holds only the three tokens the accent is
measured against. Change the CSS and change both. Four things follow:
- **One colour is chosen and four are emitted.** Hover, the label on a solid button, and the subtle
  tint are derived, because each is a question with a right answer — offering the button label as a
  choice is offering a way to make Save unreadable. What is a property of the colour itself, whether
  it is dark enough to be link text, is measured and reported instead. `accentContrast` marks which
  is which, and the UI words a derived failure differently because it would be a bug here.
- **Hover moves away from the *label*, not away from the surface.** Away-from-surface is the obvious
  rule and it is wrong: for a pale accent the label is dark, so a darker hover walks the label's
  contrast down until the button fails on hover while passing at rest. Found by sweeping the hue
  circle in `branding.test.ts`, which is the test to extend rather than replace — a derivation
  checked only on the default green is a derivation checked on the one input that cannot fail.
- **The override is one unlayered `:root` rule, and unlayered is load-bearing.** Tailwind's `@theme`
  compiles into `@layer theme`, and cascade layers beat specificity outright. Same lesson as the
  preview-width rule in `admin.css`, and the same way to verify it: read the computed value, not the
  HTML.
- **The default accent is stored as null and emits nothing.** `oklch(52% 0.15 155)` is outside sRGB,
  so `DEFAULT_ACCENT`'s hex is the nearest displayable colour rather than the same one; storing it
  would round-trip the stylesheet's own value through a hex for no reason. Null also makes "has
  anybody themed this?" a null check rather than a colour comparison.
- **`ACCENT_PRESETS` were searched, not chosen, and the test is what keeps them true.** Each pair
  passes every check in both palettes with at least the built-in green's own margin, asserted
  against the same `accentContrast` the screen renders — so a change to the derivation cannot leave
  a preset quietly failing while the UI still offers it. Validated on the *hex*, because a colour
  that passes in OKLCh and clips out of sRGB on the way to one has not passed. The first entry is
  `DEFAULT_ACCENT` exactly, or choosing "Green" would write a row and emit an override that changes
  how the admin looks for somebody who picked the colour it already was.
- **The branding screen is written in US spelling, and the code around it is not.** The admin's
  visible strings there say "color"; the comments, the root CLAUDE.md, and every other screen still
  say "colour". That is a deliberate split rather than drift — a sweep of the repo's prose is a
  separate decision from what one screen calls a control.

**Light, dark, and system are one `color-scheme` declaration, not a class.** Every colour token is
a `light-dark()` pair in the single `@theme` block, so the entire switch is three rules in
`admin.css`: `html` follows the OS, `html[data-theme='light'|'dark']` overrides it. A second
`@theme` inside a `prefers-color-scheme` media query — which is what this had before — cannot be
overridden by an attribute or a class at all, so the switcher would have nothing to switch. Setting
`color-scheme` also hands the UA its half of the work (form controls, scrollbars, the canvas behind
the page), which a class-based dark mode has to restate by hand and usually misses.

**The choice is a cookie, read on the server, and `system` is stored by deleting it.** The layout
stamps `data-theme` on `<html>` before any CSS is sent, which is why there is no inline blocking
script and no flash of the wrong palette. `localStorage` cannot do that — the server cannot see it.
`system` writes no cookie and renders no attribute, because "never chose anything" and "chose
System" must be the same state; a third value would be a second encoding of one thing, free to
drift. `resolveTheme` sends anything unrecognised back to `system` for the same reason.

**A `<label for>` must point at a labelable element** — button, input, meter, output, progress,
select, textarea. Anything else is silently inert: the control is still named through
`aria-labelledby` or a `<legend>`, so a screen reader sounds correct, axe passes, and only
click-to-focus is missing. That is why the audit checks it directly; axe's `label` rule asks
whether a control has a name, not whether a label has a target. **A custom control gets a `<span
id>` and `aria-labelledby`, not a `<label for>`** — [FieldControl](src/admin/islands/fields/FieldControl.tsx)'s
`labelsAControl()` is the worked example, and it is the audit rather than review that keeps it in
step with the branches it mirrors.

**The audit's dynamic routes must be chosen by what they exercise, not by what sorts first.** It
picks the item editor by field count, because taking `items[0]` took the alphabetically-first path
— the weather-banner singleton, three plain inputs — and left the densest screen in the admin the
one route never audited. Seven inert labels sat there through four phases as a result. Note that
`/api/taproot/content-types` returns types *without* their fields, so a count derived from that
list is zero for everything and quietly restores the bug.

What it does **not** cover, and what needs a real browser and a human: post-hydration behaviour of
the React islands, and screen-reader output. Custom interactions are where WCAG failures actually
creep in — off-the-shelf Radix primitives rarely fail. **Drag-and-drop must always be added
alongside keyboard controls, never instead of them**; the field builder's reorder buttons are the
pattern to follow.

Where a widget only exists after hydration — the richtext toolbar, since ProseMirror needs a real
DOM and the server renders an empty placeholder; the media picker, which is a dialog that has to be
opened — the audit cannot see it at all. Those get a jsdom test that runs axe on the hydrated tree
plus its keyboard contract
([RichTextEditor.test.tsx](src/admin/islands/fields/RichTextEditor.test.tsx),
[MediaPicker.test.tsx](src/admin/islands/media/MediaPicker.test.tsx)).
Scope axe to the render container, not `document`: in isolation there is no landmark around the
component, and the resulting `region` violation is an artifact of the test. **Radix dialogs are the
exception** — they portal to `document.body`, so the render container is empty and axe must be
scoped to the dialog element itself.
