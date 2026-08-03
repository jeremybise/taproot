import { useId, useState } from 'react';
import {
  ACCENT_PRESETS,
  ADMIN_PALETTE,
  DEFAULT_ACCENT,
  DEFAULT_TITLE,
  MAX_TITLE_LENGTH,
  accentContrast,
  deriveAccent,
  formatOklch,
  hexToOklch,
  type AccentPreset,
  type ContrastCheck,
  type Oklch,
  type ThemeMode,
} from '@taprootcms/core';
import { AlertTriangle, Check, RotateCcw } from 'lucide-react';

import type { MediaOption } from '../mediaOptions.js';
import { MediaField } from './media/MediaField.js';

/**
 * Branding: what the CMS calls itself, and what colour it is.
 *
 * The accent is one colour per palette and everything else is derived — hover, the label that sits
 * on a solid button, the tint behind the current sidebar item. That is not a shortcut. A button
 * label is a question with a right answer, and offering it as a choice is offering a way to make
 * the primary action unreadable; SCOPE calls this "contrast derived rather than merely warned
 * about". What is genuinely a matter of taste, and genuinely cannot be fixed from here, is whether
 * the chosen colour is dark enough to be *text* — so that one is measured and reported.
 *
 * The preview shows both palettes at once, whichever the admin is currently in. Somebody choosing a
 * dark-mode accent from a light-mode admin would otherwise be picking blind.
 */

export interface BrandingEditorProps {
  title: string | null;
  logoMediaId: string | null;
  accentLight: string | null;
  accentDark: string | null;
  /** The library's first page, for the logo picker. Images only. */
  images: MediaOption[];
}

export default function BrandingEditor({
  title: initialTitle,
  logoMediaId,
  accentLight,
  accentDark,
  images,
}: BrandingEditorProps) {
  const id = useId();
  const [title, setTitle] = useState(initialTitle ?? '');
  const [logo, setLogo] = useState<string[]>(logoMediaId ? [logoMediaId] : []);
  const [light, setLight] = useState(accentLight ?? DEFAULT_ACCENT.light);
  const [dark, setDark] = useState(accentDark ?? DEFAULT_ACCENT.dark);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const parsedLight = hexToOklch(light);
  const parsedDark = hexToOklch(dark);
  const valid = Boolean(parsedLight && parsedDark);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!valid) return;

    setBusy(true);
    setMessage(null);

    try {
      const response = await fetch('/api/taproot/settings/branding', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: title.trim() || null,
          logoMediaId: logo[0] ?? null,
          /**
           * The default is stored as nothing.
           *
           * A row holding the same colour the stylesheet already has would make the layout emit an
           * override that changes nothing, and would make "has anyone themed this?" a colour
           * comparison rather than a null check.
           */
          accentLight: light.toLowerCase() === DEFAULT_ACCENT.light ? null : light,
          accentDark: dark.toLowerCase() === DEFAULT_ACCENT.dark ? null : dark,
        }),
      });

      const body = (await response.json().catch(() => null)) as { error?: string } | null;

      if (!response.ok) {
        setFailed(true);
        setMessage(body?.error ?? `Save failed (${response.status}).`);
        return;
      }

      setFailed(false);
      // Said rather than shown: the sidebar beside this form is still the old colour until the next
      // page load, and a message that did not say so would read as the save having done nothing.
      setMessage('Branding saved. Reload to see it applied across the admin.');
    } catch {
      setFailed(true);
      setMessage('Could not reach the server. Your changes have not been saved.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-8">
      <div role="alert" aria-live="assertive">
        {message && (
          <p
            className={`rounded-md border px-4 py-3 text-sm ${
              failed ? 'border-danger bg-danger-subtle' : 'border-accent bg-accent-subtle'
            }`}
          >
            {message}
          </p>
        )}
      </div>

      {/* Name and mark ------------------------------------------------------ */}
      <section aria-labelledby={`${id}-identity`} className="space-y-4">
        <h2 id={`${id}-identity`} className="text-base font-semibold">
          Name and logo
        </h2>

        <div>
          <label htmlFor={`${id}-title`} className="block text-sm font-medium">
            Title
          </label>
          <input
            id={`${id}-title`}
            value={title}
            maxLength={MAX_TITLE_LENGTH}
            placeholder={DEFAULT_TITLE}
            aria-describedby={`${id}-title-hint`}
            onChange={(event) => setTitle(event.target.value)}
            className="mt-1.5 w-full max-w-sm rounded-md border border-border-strong bg-surface px-3 py-2 text-sm"
          />
          <p id={`${id}-title-hint`} className="mt-1.5 text-sm text-content-subtle">
            Shown in the sidebar and the browser tab. Leave it blank for “{DEFAULT_TITLE}”.
          </p>
        </div>

        <div>
          <span id={`${id}-logo-label`} className="block text-sm font-medium">
            Logo
          </span>
          <div className="max-w-md">
            {/*
              The same picker every other asset uses, rather than an upload field of its own — one
              media library means the logo has alt text, a filename, and a place it can be replaced
              from. Images only: a PDF cannot be a logo.
            */}
            <MediaField
              labelledBy={`${id}-logo-label`}
              describedBy={`${id}-logo-hint`}
              value={logo}
              onChange={setLogo}
              library={images}
              accept={['image/']}
              noun="logo"
            />
          </div>
          <p id={`${id}-logo-hint`} className="mt-1.5 text-sm text-content-subtle">
            Replaces the ◆ mark. It is scaled to the height of the title beside it, so a wide
            wordmark works as well as a square icon. Without one, the ◆ stays.
          </p>
        </div>
      </section>

      {/* Accent ------------------------------------------------------------- */}
      <section aria-labelledby={`${id}-accent`} className="space-y-4">
        <h2 id={`${id}-accent`} className="text-base font-semibold">
          Accent color
        </h2>
        <p className="max-w-prose text-sm text-content-muted">
          One color per palette, because a hue that reads well on white rarely reads well on the
          dark surface. Hover, the label on a solid button, and the tint behind the current sidebar
          item are worked out from it — those are the parts with a right answer. Status badges keep
          their own colors: they have to stay told apart from each other.
        </p>

        <Presets
          id={`${id}-presets`}
          light={light}
          dark={dark}
          onPick={(preset) => {
            setLight(preset.light);
            setDark(preset.dark);
          }}
        />

        {/* A viewport breakpoint, not a container query: this form is the whole of `#main` on its
            own screen, so the column and the viewport are the same measurement here. */}
        <div className="grid gap-6 lg:grid-cols-2">
          <AccentField
            id={`${id}-light`}
            mode="light"
            label="Light mode"
            value={light}
            onChange={setLight}
          />
          <AccentField
            id={`${id}-dark`}
            mode="dark"
            label="Dark mode"
            value={dark}
            onChange={setDark}
          />
        </div>
      </section>

      <div className="flex items-center gap-3 border-t border-border pt-5">
        <button
          type="submit"
          disabled={busy || !valid}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-content transition-colors hover:bg-accent-hover disabled:opacity-60"
        >
          {busy ? 'Saving…' : 'Save branding'}
        </button>
        {!valid && (
          <p className="text-sm text-content-subtle">
            Both accents need to be a hex color before this can be saved.
          </p>
        )}
      </div>
    </form>
  );
}

/**
 * Eight starting points, each of which passes every check in both palettes.
 *
 * A contrast table is the honest answer to "will this colour work?" and a poor way to *choose* one:
 * it can only respond to a colour you already typed. These give somebody a place to start, and the
 * measurements underneath stay in view for whatever they change it to.
 *
 * One press sets both palettes, because a preset is a pair — the two lightnesses that make one hue
 * work on white and on the dark surface are not the same, which is the whole reason the accent is
 * two settings rather than one.
 *
 * Buttons, not a radio group: this is an action that fills in two fields, not a fourth value the
 * form holds. `aria-pressed` says which one the current colours came from, and the name is text
 * rather than the swatch carrying the meaning alone.
 */
function Presets({
  id,
  light,
  dark,
  onPick,
}: {
  id: string;
  light: string;
  dark: string;
  onPick: (preset: AccentPreset) => void;
}) {
  return (
    <div>
      <p id={id} className="text-xs font-medium">
        Start from a preset
      </p>
      <ul aria-labelledby={id} className="mt-1.5 flex flex-wrap gap-2">
        {ACCENT_PRESETS.map((preset) => {
          const current =
            light.toLowerCase() === preset.light && dark.toLowerCase() === preset.dark;
          return (
            <li key={preset.name}>
              <button
                type="button"
                aria-pressed={current}
                onClick={() => onPick(preset)}
                className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm transition-colors ${
                  current
                    ? 'border-accent bg-accent-subtle font-medium'
                    : 'border-border-strong hover:bg-surface-sunken'
                }`}
              >
                {/*
                  Both halves of the pair, so the swatch shows what is actually being chosen. Fixed
                  colours rather than tokens: these are samples of a specific value, not something
                  that should follow the theme.
                */}
                <span
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0 overflow-hidden rounded-full border border-border"
                  style={{
                    background: `linear-gradient(135deg, ${preset.light} 0 50%, ${preset.dark} 50% 100%)`,
                  }}
                />
                {preset.name}
                {preset.light === DEFAULT_ACCENT.light && (
                  /* The space is a real text node, not the flex gap. The gap separates these
                     visually and contributes nothing to the accessible name, which was coming out
                     as "Green(default)". */
                  <span className="text-xs text-content-subtle">{' (default)'}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * One palette's accent: the colour, its preview, and every pair it takes part in.
 *
 * A colour input and a text box for the same value, because neither alone is enough — the swatch
 * cannot be typed into or read out by a screen reader, and a hex field alone is a worse way to
 * choose a colour than the operating system's own picker.
 */
function AccentField({
  id,
  mode,
  label,
  value,
  onChange,
}: {
  id: string;
  mode: ThemeMode;
  label: string;
  value: string;
  onChange: (hex: string) => void;
}) {
  const parsed = hexToOklch(value);
  const isDefault = value.toLowerCase() === DEFAULT_ACCENT[mode];

  return (
    <fieldset className="min-w-0 rounded-lg border border-border p-4">
      <legend className="px-1 text-sm font-medium">{label}</legend>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor={`${id}-picker`} className="block text-xs font-medium">
            Color
          </label>
          <input
            id={`${id}-picker`}
            type="color"
            /* A colour input only understands `#rrggbb`; a half-typed hex in the box beside it must
               not blank the swatch, so it falls back to the last colour that parsed. */
            value={parsed ? value : DEFAULT_ACCENT[mode]}
            onChange={(event) => onChange(event.target.value)}
            className="mt-1 h-10 w-16 cursor-pointer rounded-md border border-border-strong bg-surface"
          />
        </div>

        <div>
          <label htmlFor={`${id}-hex`} className="block text-xs font-medium">
            Hex value
          </label>
          <input
            id={`${id}-hex`}
            value={value}
            spellCheck={false}
            aria-invalid={parsed ? undefined : true}
            aria-describedby={parsed ? undefined : `${id}-hex-error`}
            onChange={(event) => onChange(event.target.value)}
            className={`mt-1 w-32 rounded-md border bg-surface px-2.5 py-2 font-mono text-sm ${
              parsed ? 'border-border-strong' : 'border-danger'
            }`}
          />
        </div>

        <button
          type="button"
          disabled={isDefault}
          onClick={() => onChange(DEFAULT_ACCENT[mode])}
          className="inline-flex items-center gap-1.5 rounded-md border border-border-strong px-3 py-2 text-sm font-medium transition-colors hover:bg-surface-sunken disabled:opacity-50"
        >
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
          Use the default
        </button>
      </div>

      {!parsed && (
        <p id={`${id}-hex-error`} className="mt-2 text-sm text-danger">
          Use a hex color such as #2f9e68.
        </p>
      )}

      {parsed && (
        <>
          <AccentPreview accent={parsed} mode={mode} />
          <ContrastReport checks={accentContrast(parsed, mode)} />
        </>
      )}
    </fieldset>
  );
}

/**
 * The accent as it will actually be seen, in its own palette.
 *
 * Rendered with inline styles from the same `deriveAccent` the layout emits, on the same fixed
 * surfaces `ADMIN_PALETTE` records — so this is the real thing rather than an impression of it.
 * It has to opt out of the surrounding theme entirely, which is what `colorScheme` is for: a dark
 * preview inside a light admin must not have the UA paint light text into it.
 */
function AccentPreview({ accent, mode }: { accent: Oklch; mode: ThemeMode }) {
  const tokens = deriveAccent(accent, mode);
  const palette = ADMIN_PALETTE[mode];

  return (
    <div
      style={{
        background: formatOklch(palette.surface),
        color: formatOklch(palette.content),
        colorScheme: mode,
      }}
      className="mt-4 flex flex-wrap items-center gap-3 rounded-md border border-border p-3"
    >
      <span
        style={{ background: formatOklch(tokens.accent), color: formatOklch(tokens.content) }}
        className="rounded-md px-3 py-1.5 text-sm font-medium"
      >
        Save
      </span>
      <span
        style={{ background: formatOklch(tokens.subtle) }}
        className="rounded-md px-3 py-1.5 text-sm font-medium"
      >
        Current page
      </span>
      <span style={{ color: formatOklch(tokens.accent) }} className="text-sm underline">
        A link
      </span>
    </div>
  );
}

/**
 * Every pair, with its ratio.
 *
 * The status is a word and an icon, never the colour of the row — the whole screen is about colour
 * being adjustable, so a red row on somebody's chosen red accent would be the one place in this
 * admin where colour carried the message alone (WCAG 1.4.1).
 */
function ContrastReport({ checks }: { checks: ContrastCheck[] }) {
  const failures = checks.filter((check) => !check.passes);

  return (
    <div className="mt-4">
      <h3 className="text-xs font-medium text-content-subtle">Contrast</h3>
      <ul className="mt-1.5 space-y-1.5">
        {checks.map((check) => (
          <li key={check.label} className="flex items-start gap-2 text-sm">
            {check.passes ? (
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-content-muted" aria-hidden="true" />
            ) : (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block">
                {check.label} —{' '}
                <span className="font-mono">{check.ratio.toFixed(2)}:1</span>{' '}
                <span className={check.passes ? 'text-content-subtle' : 'font-medium'}>
                  {check.passes ? 'passes' : `below the ${check.threshold}:1 it needs`}
                </span>
              </span>
              {!check.passes && <span className="block text-content-subtle">{check.where}</span>}
            </span>
          </li>
        ))}
      </ul>
      {failures.length > 0 && (
        <p className="mt-2 max-w-prose text-sm text-content-subtle">
          {/*
            Stated as advice, not as a refusal. Nothing here blocks a save — the same argument the
            content accessibility checker makes: a person who cannot apply their own institution's
            colour routes around the CMS, and the useful thing to do is say exactly what will be
            hard to read and why.
          */}
          {failures.some((check) => check.derived)
            ? 'Some of this is derived from your color and should not be able to fail — worth reporting.'
            : 'Nothing stops you saving this. A darker shade in light mode, or a lighter one in dark mode, is usually all it takes.'}
        </p>
      )}
    </div>
  );
}
