/**
 * Colour arithmetic for the configurable accent.
 *
 * An operator picks one colour per palette and the rest of the accent tokens are *derived* from it
 * rather than asked for. That is the whole design: `--color-accent-content` is the label on a solid
 * button, and a CMS that let somebody choose it is a CMS that lets them choose an unreadable button.
 * What cannot be derived — whether the accent itself is dark enough to be text on the page
 * background — is measured and reported instead, which is the only honest option: the answer
 * depends on the colour they wanted, and lightening it silently would hand back a different colour
 * than the one they chose.
 *
 * Everything here is pure and has no database handle, so the settings island can run it on every
 * keystroke and show the ratio moving as the colour changes. Same split as the accessibility
 * checker's rules.
 */

/** Lightness as a percentage, chroma in OKLCh units, hue in degrees. */
export interface Oklch {
  l: number;
  c: number;
  h: number;
}

/**
 * The admin's fixed tokens, as far as the accent has to be checked against them.
 *
 * **Mirrored by hand from the `@theme` block in `admin.css`, exactly as `scripts/a11y-contrast.mjs`
 * mirrors the whole of it** — and for the same reason: there is no way to resolve a CSS custom
 * property from Node, so the values have to be restated somewhere. Two copies is one more than
 * ideal; the alternative was a third place for the accent pairs to be checked, or checking them
 * nowhere. Change the CSS and change both.
 */
export const ADMIN_PALETTE = {
  light: {
    surface: { l: 99, c: 0, h: 0 },
    'surface-raised': { l: 100, c: 0, h: 0 },
    content: { l: 25, c: 0.01, h: 250 },
  },
  dark: {
    surface: { l: 21, c: 0.008, h: 250 },
    'surface-raised': { l: 25, c: 0.009, h: 250 },
    content: { l: 95, c: 0.004, h: 250 },
  },
} as const satisfies Record<string, Record<string, Oklch>>;

export type ThemeMode = keyof typeof ADMIN_PALETTE;

// --- hex <-> oklch -----------------------------------------------------------

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `null` for anything that is not a hex colour, so a stored value can never crash a render. */
export function hexToOklch(hex: string): Oklch | null {
  const match = HEX.exec(hex.trim());
  if (!match) return null;

  const digits = match[1]!;
  const full =
    digits.length === 3
      ? digits
          .split('')
          .map((d) => d + d)
          .join('')
      : digits;

  const [r, g, b] = [0, 2, 4].map((offset) =>
    srgbToLinear(parseInt(full.slice(offset, offset + 2), 16) / 255),
  ) as [number, number, number];

  return linearSrgbToOklch([r, g, b]);
}

export function oklchToHex(color: Oklch): string {
  const channels = oklchToLinearSrgb(color).map((value) => {
    const srgb = linearToSrgb(Math.min(1, Math.max(0, value)));
    return Math.round(srgb * 255)
      .toString(16)
      .padStart(2, '0');
  });
  return `#${channels.join('')}`;
}

/**
 * The CSS form, rounded.
 *
 * Matches how the tokens are written in `admin.css` — `oklch(52% 0.15 155)` — so an emitted
 * override and a hand-written default read the same in devtools.
 */
export function formatOklch({ l, c, h }: Oklch): string {
  return `oklch(${round(l, 1)}% ${round(c, 4)} ${round(h, 1)})`;
}

// --- contrast ----------------------------------------------------------------

/** WCAG relative luminance. Linear-light sRGB is already what the formula wants. */
function luminance(color: Oklch): number {
  const [r, g, b] = oklchToLinearSrgb(color);
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return 0.2126 * clamp(r) + 0.7152 * clamp(g) + 0.0722 * clamp(b);
}

export function contrastRatio(a: Oklch, b: Oklch): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}

// --- deriving the accent set -------------------------------------------------

export interface AccentTokens {
  accent: Oklch;
  hover: Oklch;
  /** What sits *on* the accent — a button label. Chosen, never configured. */
  content: Oklch;
  /** The tinted background behind the active nav item and flash messages. */
  subtle: Oklch;
}

/**
 * The four accent tokens for one palette.
 *
 * Each rule reproduces what the default green already does, so choosing the built-in colour and
 * choosing nothing are the same thing — `branding.test.ts` asserts the derived tokens are
 * byte-identical to the ones written in `admin.css`.
 *
 * - **content** is the first candidate that reaches 4.5:1 on the accent. The candidates are the two
 *   the stylesheet already uses, then black, which only the narrow band of mid-lightness colours
 *   ever needs — a colour whose luminance sits near 0.18 is equally awkward for white and for dark
 *   text, and black is the only thing that clears the bar there. It is a question with a right
 *   answer, so it is answered rather than asked.
 * - **hover** moves lightness *away from the content colour*, which is what makes this hold for
 *   colours nobody tried. Moving away from the *surface* is the obvious rule and it is wrong: for a
 *   pale accent the label is dark, and a darker hover state walks the label's contrast down until
 *   the button fails on hover while passing at rest. Found by sweeping the hue circle, not by
 *   looking.
 * - **subtle** keeps the hue and pins lightness and chroma, because the pair that has to hold is
 *   `content` on this, and that is a statement about lightness. A tint that inherited the accent's
 *   own lightness would be unreadable behind text for every dark accent.
 */
export function deriveAccent(accent: Oklch, mode: ThemeMode): AccentTokens {
  const content = accentContent(accent);

  // Away from the label, so hover can only improve the pair that matters, never worsen it.
  const away = content.l > accent.l ? -6 : 6;
  const hover: Oklch = { ...accent, l: clampLightness(accent.l + away) };

  const subtle: Oklch =
    mode === 'light'
      ? { l: 95, c: Math.min(accent.c, 0.04), h: accent.h }
      : { l: 28, c: Math.min(accent.c, 0.05), h: accent.h };

  return { accent, hover, content, subtle };
}

const WHITE: Oklch = { l: 99, c: 0, h: 0 };
const BLACK: Oklch = { l: 0, c: 0, h: 0 };

/**
 * White, the near-black the dark palette uses, or black.
 *
 * Tried in that order rather than by picking the best, so the default accent in each palette lands
 * on the token that palette already has. Falling through to the best available is the last resort;
 * with black on the list there is always one that reaches 4.5:1, and the worst case across every
 * possible colour is 4.53:1.
 */
function accentContent(accent: Oklch): Oklch {
  const candidates: Oklch[] = [WHITE, { l: 18, c: Math.min(accent.c, 0.02), h: accent.h }, BLACK];

  return (
    candidates.find((candidate) => contrastRatio(candidate, accent) >= 4.5) ??
    candidates.reduce((best, candidate) =>
      contrastRatio(candidate, accent) > contrastRatio(best, accent) ? candidate : best,
    )
  );
}

// --- the report ---------------------------------------------------------------

export interface ContrastCheck {
  /** Short name for the pair, for the table's first column. */
  label: string;
  /** Where in the admin this pair is seen, so a failure says what will look wrong. */
  where: string;
  ratio: number;
  threshold: number;
  passes: boolean;
  /** True when the pair is derived, so a failure is a fault here rather than the colour's. */
  derived: boolean;
}

/**
 * Every pair the accent takes part in, measured.
 *
 * The derived ones are expected to pass for any colour and are checked anyway — `branding.test.ts`
 * sweeps the hue circle against exactly this function, so a derivation that stopped working would
 * fail the suite rather than quietly ship an unreadable button.
 *
 * The one that can genuinely fail is the accent as *text*: rich-text links in the editor are drawn
 * in it, and whether a colour is dark enough to read on the page background is a property of the
 * colour, not of anything this can adjust.
 */
export function accentContrast(accent: Oklch, mode: ThemeMode): ContrastCheck[] {
  const tokens = deriveAccent(accent, mode);
  const palette = ADMIN_PALETTE[mode];

  return [
    {
      label: 'Button label on the accent',
      where: 'Save, Publish, and every other primary button.',
      ratio: contrastRatio(tokens.content, tokens.accent),
      threshold: 4.5,
      passes: false,
      derived: true,
    },
    {
      label: 'Button label when hovered',
      where: 'The same buttons under the pointer.',
      ratio: contrastRatio(tokens.content, tokens.hover),
      threshold: 4.5,
      passes: false,
      derived: true,
    },
    {
      label: 'Text on the accent tint',
      where: 'The current sidebar item, and the banner after a save.',
      ratio: contrastRatio(palette.content, tokens.subtle),
      threshold: 4.5,
      passes: false,
      derived: true,
    },
    {
      label: 'Accent as text',
      where: 'Links inside the rich-text editor, drawn in the accent color.',
      ratio: contrastRatio(tokens.accent, palette.surface),
      threshold: 4.5,
      passes: false,
      derived: false,
    },
    {
      label: 'Accent as an outline',
      where: 'The ring around a selected image, and borders drawn in the accent.',
      // 3:1 rather than 4.5: SC 1.4.11 covers a boundary you have to *see*, not read.
      ratio: contrastRatio(tokens.accent, palette['surface-raised']),
      threshold: 3,
      passes: false,
      derived: false,
    },
  ].map((check) => ({ ...check, passes: check.ratio >= check.threshold }));
}

// --- conversions --------------------------------------------------------------

function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel: number): number {
  return channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
}

/** Björn Ottosson's OKLab matrices, in the direction `a11y-contrast.mjs` also uses. */
function oklchToLinearSrgb({ l, c, h }: Oklch): [number, number, number] {
  const L = l / 100;
  const radians = (h * Math.PI) / 180;
  const a = c * Math.cos(radians);
  const b = c * Math.sin(radians);

  const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

function linearSrgbToOklch([r, g, b]: [number, number, number]): Oklch {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

  const chroma = Math.sqrt(A * A + B * B);
  // A grey has no meaningful hue; `atan2(0, 0)` is 0, which is red and would tint every derived
  // token the moment chroma stopped being exactly zero.
  const hue = chroma < 1e-6 ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;

  return { l: L * 100, c: chroma, h: hue };
}

function clampLightness(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
