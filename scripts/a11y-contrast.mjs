/**
 * Colour-contrast check for the admin design tokens.
 *
 * The axe run cannot measure contrast — jsdom computes no layout and does not resolve CSS custom
 * properties — so the token pairs are checked directly here instead of being assumed correct.
 *
 * Thresholds are WCAG 2.1: 4.5:1 for normal text (SC 1.4.3), 3:1 for large text and for UI
 * component and focus indicators (SC 1.4.11).
 *
 * Usage: node scripts/a11y-contrast.mjs
 */

// Mirrors the @theme blocks in packages/astro/src/admin/admin.css.
const LIGHT = {
  surface: [99, 0, 0],
  'surface-raised': [100, 0, 0],
  'surface-sunken': [97, 0.003, 250],
  border: [90, 0.005, 250],
  'border-strong': [64, 0.008, 250],
  content: [25, 0.01, 250],
  'content-muted': [50, 0.012, 250],
  'content-subtle': [54, 0.012, 250],
  accent: [52, 0.15, 155],
  'accent-content': [99, 0, 0],
  'accent-subtle': [95, 0.04, 155],
  danger: [52, 0.19, 25],
  'danger-hover': [46, 0.19, 25],
  'danger-content': [99, 0, 0],
  'danger-subtle': [96, 0.03, 25],
  warning: [62, 0.14, 75],
  'warning-subtle': [96, 0.04, 75],
  'status-draft': [58, 0.01, 250],
  'status-draft-subtle': [95, 0.004, 250],
  'status-review': [62, 0.14, 75],
  'status-review-subtle': [96, 0.04, 75],
  'status-scheduled': [55, 0.16, 285],
  'status-scheduled-subtle': [95, 0.04, 285],
  'status-published': [52, 0.15, 155],
  'status-published-subtle': [95, 0.04, 155],
  'status-archived': [55, 0.12, 320],
  'status-archived-subtle': [95, 0.03, 320],
  focus: [55, 0.19, 250],
};

const DARK = {
  surface: [21, 0.008, 250],
  'surface-raised': [25, 0.009, 250],
  'surface-sunken': [17, 0.008, 250],
  border: [32, 0.01, 250],
  'border-strong': [53, 0.012, 250],
  content: [95, 0.004, 250],
  'content-muted': [74, 0.01, 250],
  'content-subtle': [64, 0.012, 250],
  accent: [70, 0.15, 155],
  'accent-content': [18, 0.02, 155],
  'accent-subtle': [28, 0.05, 155],
  danger: [66, 0.18, 25],
  'danger-hover': [72, 0.18, 25],
  'danger-content': [18, 0.02, 25],
  'danger-subtle': [28, 0.06, 25],
  warning: [75, 0.13, 75],
  'warning-subtle': [30, 0.05, 75],
  'status-draft': [70, 0.015, 250],
  'status-draft-subtle': [30, 0.008, 250],
  'status-review': [75, 0.13, 75],
  'status-review-subtle': [30, 0.05, 75],
  'status-scheduled': [74, 0.13, 285],
  'status-scheduled-subtle': [30, 0.06, 285],
  'status-published': [70, 0.15, 155],
  'status-published-subtle': [28, 0.05, 155],
  'status-archived': [72, 0.12, 320],
  'status-archived-subtle': [30, 0.05, 320],
  focus: [72, 0.16, 250],
};

/** Pairs that actually occur in the UI, with the threshold each must meet. */
const PAIRS = [
  ['content', 'surface', 4.5, 'body text on the page background'],
  ['content', 'surface-raised', 4.5, 'body text on cards and table rows'],
  ['content', 'surface-sunken', 4.5, 'body text on the sidebar and table headers'],
  ['content-muted', 'surface', 4.5, 'secondary text'],
  ['content-muted', 'surface-raised', 4.5, 'secondary text on cards'],
  ['content-subtle', 'surface', 4.5, 'hint and help text'],
  ['content-subtle', 'surface-raised', 4.5, 'hint text on cards'],
  ['accent-content', 'accent', 4.5, 'primary button label'],
  ['content', 'accent-subtle', 4.5, 'text on the active nav item and flash messages'],
  ['content', 'danger-subtle', 4.5, 'text in error banners'],
  ['content', 'warning-subtle', 4.5, 'text in warning banners'],
  ['danger', 'surface-raised', 4.5, 'inline validation messages'],
  ['danger', 'surface', 4.5, 'destructive text-button label'],
  ['danger-content', 'danger', 4.5, 'solid destructive button label'],
  ['danger-content', 'danger-hover', 4.5, 'solid destructive button label, hovered'],
  ['border-strong', 'surface', 3, 'input borders (UI component boundary)'],
  ['focus', 'surface', 3, 'focus ring on the page background'],
  ['focus', 'surface-raised', 3, 'focus ring on cards'],
  ['focus', 'surface-sunken', 3, 'focus ring in the sidebar'],

  // Status badges. The label sits on the `-subtle` fill, so that pair carries text and needs
  // 4.5:1. The badge border is held to the 3:1 non-text threshold against both backgrounds a
  // badge can appear on — a table row (surface) and the editor sidebar card (surface-raised) —
  // because a status colour nobody can see is the same as not colour-coding at all.
  ...['draft', 'review', 'scheduled', 'published', 'archived'].flatMap((name) => [
    ['content', `status-${name}-subtle`, 4.5, `${name} badge label`],
    [`status-${name}`, 'surface', 3, `${name} badge border on a table row`],
    [`status-${name}`, 'surface-raised', 3, `${name} badge border on a card`],
  ]),
];

// --- oklch -> sRGB -> relative luminance ------------------------------------

function oklchToLinearSrgb(lPercent, chroma, hueDegrees) {
  const L = lPercent / 100;
  const h = (hueDegrees * Math.PI) / 180;
  const a = chroma * Math.cos(h);
  const b = chroma * Math.sin(h);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;

  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** WCAG relative luminance. Linear-light sRGB is already what the formula wants. */
function luminance([r, g, b]) {
  const clamp = (v) => Math.min(1, Math.max(0, v));
  return 0.2126 * clamp(r) + 0.7152 * clamp(g) + 0.0722 * clamp(b);
}

function contrastRatio(colorA, colorB) {
  const a = luminance(oklchToLinearSrgb(...colorA));
  const b = luminance(oklchToLinearSrgb(...colorB));
  const [light, dark] = a > b ? [a, b] : [b, a];
  return (light + 0.05) / (dark + 0.05);
}

// --- Report ------------------------------------------------------------------

let failures = 0;

for (const [themeName, theme] of [
  ['light', LIGHT],
  ['dark', DARK],
]) {
  console.log(`\n${themeName} theme`);

  for (const [fg, bg, threshold, description] of PAIRS) {
    const ratio = contrastRatio(theme[fg], theme[bg]);
    const pass = ratio >= threshold;
    if (!pass) failures++;

    console.log(
      `  ${pass ? 'PASS' : 'FAIL'}  ${ratio.toFixed(2)}:1  (needs ${threshold}:1)  ` +
        `${fg} on ${bg} — ${description}`,
    );
  }
}

console.log(
  failures === 0
    ? '\nAll token pairs meet their WCAG 2.1 threshold.'
    : `\n${failures} pair(s) below threshold.`,
);

process.exit(failures === 0 ? 0 : 1);
