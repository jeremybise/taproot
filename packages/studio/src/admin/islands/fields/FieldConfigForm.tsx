import { useEffect, useId, useState } from 'react';
import {
  FIELD_TYPE_META,
  REPEATER_SUB_FIELD_TYPES,
  type ContentTypeRow,
  type FieldType,
  type TaxonomyRow,
  type VisibilityCondition,
} from '@taprootcms/core';

import { VisibilityEditor } from './VisibilityEditor.js';

/**
 * Per-field-type option forms.
 *
 * These mirror `fieldConfigSchemas` in packages/core/src/validation/fields.ts, which stays the
 * single source of truth — the server re-validates every config on save, so a form that drifts
 * produces a clear API error rather than corrupt data. `fieldConfigForms.test.ts` asserts every
 * field type has an entry here, so adding a type to core and forgetting the UI fails the suite.
 */

export interface ConfigFormProps {
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  /** Available content types, for the relation target picker. */
  contentTypes: ContentTypeRow[];
  /** Available taxonomies, for the taxonomy field's source picker. */
  taxonomies: TaxonomyRow[];
  /** Content type being edited, so a relation cannot silently target nothing. */
  currentContentTypeId: string;
  /** Block types available to place in a block field. */
  blockTypes?: ContentTypeRow[];
}

type ConfigForm = (props: ConfigFormProps) => React.ReactElement | null;

// --- shared inputs ----------------------------------------------------------

const inputClass =
  'mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm';

/**
 * Two columns when the *panel* is wide enough, not when the window is.
 *
 * `@container` on the row itself: the field config renders in the builder's right pane and, in the
 * item editor, inside a 26rem rail while the viewport is ≥1280px. A viewport-keyed `sm:` fires in
 * both, which is how a 416px column ends up with two 190px inputs side by side.
 */
function Row({ children }: { children: React.ReactNode }) {
  return (
    <div className="@container">
      <div className="grid gap-4 @sm:grid-cols-2">{children}</div>
    </div>
  );
}

function NumberInput({
  label,
  value,
  onChange,
  hint,
  min,
}: {
  label: string;
  value: unknown;
  onChange: (value: number | undefined) => void;
  hint?: string;
  min?: number;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">
        {label} <span className="font-normal text-content-subtle">(optional)</span>
      </label>
      {hint && (
        <p id={`${id}-hint`} className="mt-0.5 text-xs text-content-subtle">
          {hint}
        </p>
      )}
      <input
        id={id}
        type="number"
        min={min}
        aria-describedby={hint ? `${id}-hint` : undefined}
        value={typeof value === 'number' ? String(value) : ''}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        className={inputClass}
      />
    </div>
  );
}

function TextInput({
  label,
  value,
  onChange,
  hint,
  placeholder,
}: {
  label: string;
  value: unknown;
  onChange: (value: string | undefined) => void;
  hint?: string;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">
        {label} <span className="font-normal text-content-subtle">(optional)</span>
      </label>
      {hint && (
        <p id={`${id}-hint`} className="mt-0.5 text-xs text-content-subtle">
          {hint}
        </p>
      )}
      <input
        id={id}
        type="text"
        placeholder={placeholder}
        aria-describedby={hint ? `${id}-hint` : undefined}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value || undefined)}
        className={inputClass}
      />
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1"
      />
      <div>
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        {hint && (
          <p id={`${id}-hint`} className="text-xs text-content-subtle">
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}

function NoOptions({ note }: { note: string }) {
  return <p className="text-sm text-content-subtle">{note}</p>;
}

// --- per-type forms ---------------------------------------------------------

const TextConfig: ConfigForm = ({ config, onChange }) => (
  <div className="space-y-4">
    <Toggle
      label="Multiline"
      hint="Renders a resizable text area instead of a single-line input."
      checked={config.multiline === true}
      onChange={(multiline) => onChange({ ...config, multiline })}
    />
    <Row>
      <NumberInput
        label="Minimum length"
        min={0}
        value={config.minLength}
        onChange={(minLength) => onChange({ ...config, minLength })}
      />
      <NumberInput
        label="Maximum length"
        min={1}
        value={config.maxLength}
        onChange={(maxLength) => onChange({ ...config, maxLength })}
      />
    </Row>
    <TextInput
      label="Placeholder"
      value={config.placeholder}
      onChange={(placeholder) => onChange({ ...config, placeholder })}
    />
    <TextInput
      label="Pattern"
      hint="A regular expression the value must match. An invalid pattern is ignored rather than blocking edits."
      placeholder="^[A-Z]{2}-\d{4}$"
      value={config.pattern}
      onChange={(pattern) => onChange({ ...config, pattern })}
    />
  </div>
);

const RichtextConfig: ConfigForm = ({ config, onChange }) => (
  <div className="space-y-4">
    <NumberInput
      label="Maximum length"
      min={1}
      hint="Counted in characters of the stored markup."
      value={config.maxLength}
      onChange={(maxLength) => onChange({ ...config, maxLength })}
    />
    {/*
      No plan vocabulary. This said the toolbar options "arrive with the rich-text editor in the
      next tranche" and named a phase number, long after both had shipped — the same bug as the
      "Phase N" badges the field-type picker used to render at a campus editor.
    */}
    <p className="rounded-md border border-border bg-surface-sunken px-3 py-2.5 text-xs text-content-subtle">
      Narrowing the formats an editor can use is also what keeps a page's heading order sane — the
      accessibility report flags a body heading that skips a level.
    </p>
  </div>
);

const NumberConfig: ConfigForm = ({ config, onChange }) => (
  <div className="space-y-4">
    <Row>
      <NumberInput
        label="Minimum"
        value={config.min}
        onChange={(min) => onChange({ ...config, min })}
      />
      <NumberInput
        label="Maximum"
        value={config.max}
        onChange={(max) => onChange({ ...config, max })}
      />
    </Row>
    <Toggle
      label="Whole numbers only"
      hint="Rejects values with a decimal component."
      checked={config.integer === true}
      onChange={(integer) => onChange({ ...config, integer })}
    />
    {config.integer !== true && (
      <NumberInput
        label="Step"
        hint="Increment used by the input's spinner."
        value={config.step}
        onChange={(step) => onChange({ ...config, step })}
      />
    )}
  </div>
);

const BooleanConfig: ConfigForm = ({ config, onChange }) => (
  <Toggle
    label="Default to on"
    hint="New content items start with this toggle enabled."
    checked={config.defaultValue === true}
    onChange={(defaultValue) => onChange({ ...config, defaultValue })}
  />
);

const DateConfig: ConfigForm = ({ config, onChange }) => (
  <div className="space-y-4">
    <Toggle
      label="Include a time"
      hint="Stores a full timestamp rather than a date alone."
      checked={config.includeTime === true}
      onChange={(includeTime) => onChange({ ...config, includeTime })}
    />
    <Row>
      <TextInput
        label="Earliest allowed"
        placeholder="2026-01-01"
        value={config.min}
        onChange={(min) => onChange({ ...config, min })}
      />
      <TextInput
        label="Latest allowed"
        placeholder="2027-12-31"
        value={config.max}
        onChange={(max) => onChange({ ...config, max })}
      />
    </Row>
  </div>
);

const SelectConfig: ConfigForm = ({ config, onChange }) => {
  const options = Array.isArray(config.options)
    ? (config.options as { label: string; value: string }[])
    : [];

  function update(next: { label: string; value: string }[]) {
    onChange({ ...config, options: next });
  }

  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="text-sm font-medium">Options</legend>
        <p className="mt-0.5 text-xs text-content-subtle">
          The stored value is what ends up in the content; the label is what editors see. Changing
          a stored value orphans that choice on existing items.
        </p>

        <ul className="mt-2 space-y-2">
          {options.map((option, index) => (
            <li key={index} className="flex flex-wrap items-end gap-2">
              <div className="min-w-32 flex-1">
                {/*
                  "Option label" rather than "Label": the field's own label input is on the same
                  screen, and two controls both announced as "Label" is ambiguous to anyone
                  navigating by form control rather than by sight.
                */}
                <label htmlFor={`opt-label-${index}`} className="block text-xs text-content-muted">
                  Option label
                </label>
                <input
                  id={`opt-label-${index}`}
                  value={option.label}
                  onChange={(e) => {
                    const next = [...options];
                    next[index] = { ...option, label: e.target.value };
                    update(next);
                  }}
                  className="mt-1 w-full rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-sm"
                />
              </div>

              <div className="min-w-32 flex-1">
                <label htmlFor={`opt-value-${index}`} className="block text-xs text-content-muted">
                  Stored value
                </label>
                <input
                  id={`opt-value-${index}`}
                  value={option.value}
                  onChange={(e) => {
                    const next = [...options];
                    next[index] = { ...option, value: e.target.value };
                    update(next);
                  }}
                  className="mt-1 w-full rounded-md border border-border-strong bg-surface px-2.5 py-1.5 font-mono text-sm"
                />
              </div>

              <button
                type="button"
                onClick={() => update(options.filter((_, i) => i !== index))}
                className="rounded-md border border-border-strong px-2.5 py-1.5 text-sm text-danger hover:bg-danger-subtle"
              >
                Remove
                <span className="sr-only-focusable">
                  {' '}
                  the option {option.label || `at position ${index + 1}`}
                </span>
              </button>
            </li>
          ))}
        </ul>

        {options.length === 0 && (
          <p className="mt-2 rounded-md border border-dashed border-border px-3 py-3 text-sm text-content-subtle">
            No options yet. A select field needs at least one before it can be saved.
          </p>
        )}

        <button
          type="button"
          onClick={() => update([...options, { label: '', value: '' }])}
          className="mt-3 rounded-md border border-border-strong px-3 py-1.5 text-sm font-medium hover:bg-surface-sunken"
        >
          Add option
        </button>
      </fieldset>

      <Toggle
        label="Allow multiple selections"
        hint="Renders a checkbox group and stores an array of values."
        checked={config.multiple === true}
        onChange={(multiple) => onChange({ ...config, multiple })}
      />
    </div>
  );
};

const MediaConfig: ConfigForm = ({ config, onChange }) => {
  const accept = Array.isArray(config.accept) ? (config.accept as string[]) : [];
  const presets = [
    { label: 'Images', value: 'image/' },
    { label: 'Video', value: 'video/' },
    { label: 'Audio', value: 'audio/' },
    { label: 'Documents', value: 'application/' },
  ];

  return (
    <div className="space-y-4">
      <Toggle
        label="Allow multiple files"
        checked={config.multiple === true}
        onChange={(multiple) => onChange({ ...config, multiple })}
      />

      <fieldset>
        <legend className="text-sm font-medium">Accepted types</legend>
        <p className="mt-0.5 text-xs text-content-subtle">
          Leave all unchecked to accept anything in the library.
        </p>
        <div className="mt-2 space-y-1.5">
          {presets.map((preset) => (
            <div key={preset.value} className="flex items-center gap-2">
              <input
                id={`accept-${preset.value}`}
                type="checkbox"
                checked={accept.includes(preset.value)}
                onChange={(e) =>
                  onChange({
                    ...config,
                    accept: e.target.checked
                      ? [...accept, preset.value]
                      : accept.filter((a) => a !== preset.value),
                  })
                }
              />
              <label htmlFor={`accept-${preset.value}`} className="text-sm">
                {preset.label}
              </label>
            </div>
          ))}
        </div>
      </fieldset>
    </div>
  );
};

/**
 * A link field's only choice: which of the three destinations the dialog offers.
 *
 * Phrased as an allowlist that is empty by default, matching `media`'s accept list — "leave all
 * unchecked to allow anything" is a pattern this builder already teaches, and it means a field
 * created without opening this form is the useful one rather than the useless one.
 */
/**
 * Which snippet kinds this field will accept.
 *
 * Empty means any, matching `media`'s `accept` and `link`'s `allowedKinds` — and deliberately
 * *unlike* `embed.allowedHosts`, where empty admits nothing. The difference is what the list bounds:
 * that one is a security boundary against framing an arbitrary origin, so its permissive
 * fallthrough would be the dangerous one. This narrows a picker over rows the CMS already holds.
 */
const SnippetConfig: ConfigForm = ({ config, onChange }) => {
  const allowed = Array.isArray(config.allowedKinds) ? (config.allowedKinds as string[]) : [];
  const kinds = [
    { value: 'text', label: 'Text' },
    { value: 'number', label: 'Number' },
    { value: 'date', label: 'Date' },
  ];

  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="text-sm font-medium">Allowed kinds</legend>
        <p className="mt-0.5 text-xs text-content-subtle">
          Leave all unchecked to allow any. Narrowing to Number is what stops a chart's data point
          being pointed at a sentence.
        </p>
        <div className="mt-2 space-y-1.5">
          {kinds.map((kind) => (
            <div key={kind.value} className="flex items-center gap-2">
              <input
                id={`snippet-kind-${kind.value}`}
                type="checkbox"
                checked={allowed.includes(kind.value)}
                onChange={(e) =>
                  onChange({
                    ...config,
                    allowedKinds: e.target.checked
                      ? [...allowed, kind.value]
                      : allowed.filter((entry) => entry !== kind.value),
                  })
                }
              />
              <label htmlFor={`snippet-kind-${kind.value}`} className="text-sm">
                {kind.label}
              </label>
            </div>
          ))}
        </div>
      </fieldset>

      <p className="text-xs text-content-subtle">
        Editors manage the values under Library → Text snippets. To put one in the middle of a
        sentence instead, type its <code className="font-mono">{'{{ token }}'}</code> into any text
        or rich text field — no field needed.
      </p>
    </div>
  );
};

const LinkConfig: ConfigForm = ({ config, onChange }) => {
  const allowed = Array.isArray(config.allowedKinds) ? (config.allowedKinds as string[]) : [];
  const kinds = [
    { value: 'item', label: 'A page on this site' },
    { value: 'media', label: 'A file from the media library' },
    { value: 'url', label: 'A web address' },
  ];

  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="text-sm font-medium">Allowed destinations</legend>
        <p className="mt-0.5 text-xs text-content-subtle">
          Leave all unchecked to allow any of them.
        </p>
        <div className="mt-2 space-y-1.5">
          {kinds.map((kind) => (
            <div key={kind.value} className="flex items-center gap-2">
              <input
                id={`link-kind-${kind.value}`}
                type="checkbox"
                checked={allowed.includes(kind.value)}
                onChange={(e) =>
                  onChange({
                    ...config,
                    allowedKinds: e.target.checked
                      ? [...allowed, kind.value]
                      : allowed.filter((entry) => entry !== kind.value),
                  })
                }
              />
              <label htmlFor={`link-kind-${kind.value}`} className="text-sm">
                {kind.label}
              </label>
            </div>
          ))}
        </div>
      </fieldset>

      <p className="text-xs text-content-subtle">
        A link carries its own optional label, and whether it opens in a new tab. For a row of
        buttons, put this field inside a repeater.
      </p>
    </div>
  );
};

/**
 * Common embed providers, offered as one-click presets.
 *
 * **Presets, not a default.** The stored `allowedHosts` starts empty and empty admits nothing, so a
 * field is fail-closed until somebody decides — see `embedValueSchema` in core. Baking these in as
 * the default would have Taproot assert which providers a site uses, which is the same thing the
 * `termHref` callback exists to avoid, one level down. Offering them costs a click and asserts
 * nothing.
 *
 * Each entry lists the host that actually serves the *frame*, which is often not the one in the
 * address bar: a Vimeo video is embedded from `player.vimeo.com`, and a YouTube embed from
 * `youtube-nocookie.com` if the site cares about what it sets before somebody presses play.
 */
const EMBED_PRESETS: { label: string; hosts: string[] }[] = [
  { label: 'YouTube', hosts: ['youtube.com', 'youtube-nocookie.com'] },
  { label: 'Vimeo', hosts: ['player.vimeo.com'] },
  { label: 'Google Maps', hosts: ['google.com'] },
  { label: 'Google Forms & Docs', hosts: ['docs.google.com'] },
];

/**
 * An embed field's two decisions: which domains it may frame, and how the frame gets its height.
 *
 * Both belong to the *admin* rather than to each editor — see the `embed` config schema in core for
 * why one field cannot hold a video on one page and a form on another, and why that is the right
 * consequence rather than a limitation to work around.
 */
const EmbedConfig: ConfigForm = ({ config, onChange }) => {
  const hostsId = useId();
  const modeName = useId();

  const hosts = Array.isArray(config.allowedHosts) ? (config.allowedHosts as string[]) : [];
  const sizing =
    typeof config.sizing === 'object' && config.sizing !== null
      ? (config.sizing as { mode?: string; ratio?: number; height?: number; minHeight?: number })
      : {};
  const mode = sizing.mode === 'fixed' || sizing.mode === 'auto' ? sizing.mode : 'ratio';

  /**
   * One host per line, because that is the shape somebody pastes and the shape they can read back.
   * Split on any whitespace or comma so a comma-separated paste — which is what a person who has
   * written a CSP header will type — lands correctly rather than becoming one impossible host.
   */
  const splitHosts = (raw: string) =>
    raw
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);

  /**
   * The textarea shows what was **typed**, not the normalised list read back.
   *
   * Rendering `hosts.join('\n')` is the obvious version and is broken: the separator is stripped by
   * the split on the same keystroke that produced it, so typing `youtube.com, player.vimeo.com`
   * loses the comma and the space as they are typed and stores the single impossible host
   * `youtube.complayer.vimeo.com`. Normalising a controlled input on every keystroke destroys
   * whatever the author is in the middle of typing.
   *
   * Local text wins only while it still *means* the stored list. When they disagree, something
   * other than this box wrote the config — a different field selected into the same form instance —
   * and the store is the truth. That comparison is why this needs no effect and no remount key.
   */
  const [typed, setTyped] = useState(() => hosts.join('\n'));
  const shown = sameHosts(splitHosts(typed), hosts) ? typed : hosts.join('\n');

  const setHosts = (raw: string) => {
    setTyped(raw);
    onChange({ ...config, allowedHosts: splitHosts(raw) });
  };

  const setMode = (next: 'ratio' | 'fixed' | 'auto') =>
    onChange({
      ...config,
      sizing:
        next === 'ratio'
          ? { mode: 'ratio', ratio: sizing.ratio ?? 16 / 9 }
          : next === 'fixed'
            ? { mode: 'fixed', height: sizing.height ?? 600 }
            : { mode: 'auto', minHeight: sizing.minHeight ?? 400 },
    });

  return (
    <div className="space-y-5">
      <div>
        <label htmlFor={hostsId} className="block text-sm font-medium">
          Approved sites
        </label>
        <p id={`${hostsId}-hint`} className="mt-0.5 text-xs text-content-subtle">
          One domain per line. A domain covers everything under it, so <code>youtube.com</code> also
          allows <code>www.youtube.com</code>. Editors cannot embed anything from a site that is not
          listed here.
        </p>
        <textarea
          id={hostsId}
          rows={4}
          value={shown}
          aria-describedby={`${hostsId}-hint`}
          onChange={(e) => setHosts(e.target.value)}
          className={`${inputClass} font-mono`}
          placeholder="youtube.com"
        />

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-xs text-content-subtle">Add:</span>
          {EMBED_PRESETS.map((preset) => {
            const already = preset.hosts.every((host) => hosts.includes(host));
            return (
              <button
                key={preset.label}
                type="button"
                disabled={already}
                onClick={() =>
                  onChange({
                    ...config,
                    allowedHosts: [...hosts, ...preset.hosts.filter((h) => !hosts.includes(h))],
                  })
                }
                className="rounded-md border border-border px-2 py-1 text-xs text-content-muted transition-colors hover:bg-surface-sunken hover:text-content disabled:opacity-40"
              >
                {preset.label}
              </button>
            );
          })}
        </div>
      </div>

      {/*
        A radio group rather than a `<select>` or hand-built tabs. Three options, each needing a
        sentence of explanation that a `<select>` has nowhere to put — and the house rule about
        custom widgets settles the rest: this is the platform's own single-choice control.
      */}
      <fieldset>
        <legend className="text-sm font-medium">Frame height</legend>
        <div className="mt-2 space-y-2.5">
          <SizingChoice
            name={modeName}
            value="ratio"
            checked={mode === 'ratio'}
            onSelect={setMode}
            label="Keep an aspect ratio"
            hint="Right for video and most maps. Needs no JavaScript on the site."
          />
          <SizingChoice
            name={modeName}
            value="fixed"
            checked={mode === 'fixed'}
            onSelect={setMode}
            label="A fixed height"
            hint="A stated number of pixels, whatever the frame contains."
          />
          <SizingChoice
            name={modeName}
            value="auto"
            checked={mode === 'auto'}
            onSelect={setMode}
            label="Let the embed report its height"
            hint="For forms that grow as somebody fills them in. The embedded page has to send its height, and the site has to be built to listen — see the handbook."
          />
        </div>

        <div className="mt-3">
          {mode === 'ratio' && (
            <NumberInput
              label="Ratio (width ÷ height)"
              hint="1.778 is 16:9, 1.333 is 4:3, 1 is square."
              value={sizing.ratio ?? 16 / 9}
              min={0}
              onChange={(ratio) => onChange({ ...config, sizing: { mode: 'ratio', ratio } })}
            />
          )}
          {mode === 'fixed' && (
            <NumberInput
              label="Height in pixels"
              value={sizing.height ?? 600}
              min={1}
              onChange={(height) => onChange({ ...config, sizing: { mode: 'fixed', height } })}
            />
          )}
          {mode === 'auto' && (
            <NumberInput
              label="Minimum height in pixels"
              hint="What the frame stands at before the embed reports, and what it keeps if it never does."
              value={sizing.minHeight ?? 400}
              min={1}
              onChange={(minHeight) => onChange({ ...config, sizing: { mode: 'auto', minHeight } })}
            />
          )}
        </div>
      </fieldset>
    </div>
  );
};

function sameHosts(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

function SizingChoice({
  name,
  value,
  checked,
  onSelect,
  label,
  hint,
}: {
  name: string;
  value: 'ratio' | 'fixed' | 'auto';
  checked: boolean;
  onSelect: (value: 'ratio' | 'fixed' | 'auto') => void;
  label: string;
  hint: string;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <input
        id={id}
        type="radio"
        name={name}
        checked={checked}
        aria-describedby={`${id}-hint`}
        onChange={() => onSelect(value)}
        className="mt-1"
      />
      <div>
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <p id={`${id}-hint`} className="text-xs text-content-subtle">
          {hint}
        </p>
      </div>
    </div>
  );
}

const RelationConfig: ConfigForm = ({ config, onChange, contentTypes, currentContentTypeId }) => {
  const targetId = useId();
  return (
    <div className="space-y-4">
      <div>
        <label htmlFor={targetId} className="block text-sm font-medium">
          Target content type
        </label>
        <p id={`${targetId}-hint`} className="mt-0.5 text-xs text-content-subtle">
          Which type this field points at. Self-references are allowed — a Page relating to other
          Pages is a normal thing to want.
        </p>
        <select
          id={targetId}
          aria-describedby={`${targetId}-hint`}
          value={typeof config.targetContentTypeId === 'string' ? config.targetContentTypeId : ''}
          onChange={(e) => onChange({ ...config, targetContentTypeId: e.target.value || null })}
          className={inputClass}
        >
          <option value="">— Choose a content type —</option>
          {contentTypes.map((type) => (
            <option key={type.id} value={type.id}>
              {type.name}
              {type.id === currentContentTypeId ? ' (this type)' : ''}
            </option>
          ))}
        </select>
      </div>

      <Toggle
        label="Allow multiple references"
        checked={config.multiple === true}
        onChange={(multiple) => onChange({ ...config, multiple })}
      />

      <TextInput
        label="Reverse label"
        hint="Shown on the target type's editor for the other side of this relationship."
        placeholder="Referenced by"
        value={config.reverseLabel}
        onChange={(reverseLabel) => onChange({ ...config, reverseLabel })}
      />

    </div>
  );
};

const TaxonomyConfig: ConfigForm = ({ config, onChange, taxonomies }) => (
  <div className="space-y-4">
    <div>
      <label htmlFor="taxonomy-source" className="block text-sm font-medium">
        Taxonomy
      </label>
      <select
        id="taxonomy-source"
        className={inputClass}
        value={typeof config.taxonomyId === 'string' ? config.taxonomyId : ''}
        onChange={(e) => onChange({ ...config, taxonomyId: e.target.value || null })}
      >
        <option value="">— Choose a taxonomy —</option>
        {taxonomies.map((taxonomy) => (
          <option key={taxonomy.id} value={taxonomy.id}>
            {taxonomy.name_plural}
          </option>
        ))}
      </select>
    </div>

    <Toggle
      label="Allow multiple terms"
      checked={config.multiple !== false}
      onChange={(multiple) => onChange({ ...config, multiple })}
    />

    {taxonomies.length === 0 && (
      <p className="rounded-md border border-border bg-surface-sunken px-3 py-2.5 text-xs text-content-subtle">
        No taxonomies exist yet. Create one under Taxonomies, then come back and point this field
        at it — the field can be saved without a taxonomy meanwhile.
      </p>
    )}
  </div>
);

/**
 * What the admin fixes about a query; the editor fills in the rest on each placement.
 *
 * The split is the feature — see `fieldConfigSchemas.query`. Everything here bounds what may be
 * asked, so one "Faculty" block type can serve twenty department pages with each page's editor
 * choosing their own term.
 */
const QueryConfig: ConfigForm = ({ config, onChange, contentTypes, taxonomies }) => {
  const id = useId();
  const target = typeof config.targetContentTypeId === 'string' ? config.targetContentTypeId : '';

  /**
   * The target type's date fields, fetched rather than passed in.
   *
   * `contentTypes` here is the list endpoint's output, which returns types *without* their fields —
   * the same detail that silently broke the a11y audit's route selection. Deriving the options from
   * it would mean an always-empty picker, so the fields are asked for when a target is chosen.
   */
  const [dateFields, setDateFields] = useState<{ api_id: string; label: string }[]>([]);

  useEffect(() => {
    if (!target) {
      setDateFields([]);
      return;
    }

    let cancelled = false;
    fetch(`/api/taproot/content-types/${target}/fields`, { headers: { accept: 'application/json' } })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('failed'))))
      .then((body: { fields: { api_id: string; label: string; type: string }[] }) => {
        if (cancelled) return;
        setDateFields(body.fields.filter((field) => field.type === 'date'));
      })
      // An unreachable server leaves the picker empty rather than the form broken; the stored value
      // is untouched either way.
      .catch(() => !cancelled && setDateFields([]));

    return () => {
      cancelled = true;
    };
  }, [target]);

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor={`${id}-target`} className="block text-sm font-medium">
          Content type to list
        </label>
        <p id={`${id}-target-hint`} className="mt-0.5 text-xs text-content-subtle">
          What the listing is made of — Events, Staff profiles. Singletons and block types are not
          offered, because neither has items a visitor can open.
        </p>
        <select
          id={`${id}-target`}
          aria-describedby={`${id}-target-hint`}
          className={inputClass}
          value={typeof config.targetContentTypeId === 'string' ? config.targetContentTypeId : ''}
          onChange={(e) => onChange({ ...config, targetContentTypeId: e.target.value || null })}
        >
          <option value="">— Choose a content type —</option>
          {contentTypes
            .filter((type) => type.kind === 'page' || type.kind === 'collection')
            .map((type) => (
              <option key={type.id} value={type.id}>
                {type.name_plural}
              </option>
            ))}
        </select>
      </div>

      <div>
        <label htmlFor={`${id}-taxonomy`} className="block text-sm font-medium">
          Let editors narrow by
        </label>
        <p id={`${id}-taxonomy-hint`} className="mt-0.5 text-xs text-content-subtle">
          Which taxonomy the editor may filter on when they place this block. Choosing a term always
          includes everything filed beneath it, so picking “Sciences” finds a page filed under
          “Biology”.
        </p>
        <select
          id={`${id}-taxonomy`}
          aria-describedby={`${id}-taxonomy-hint`}
          className={inputClass}
          value={typeof config.taxonomyId === 'string' ? config.taxonomyId : ''}
          onChange={(e) => onChange({ ...config, taxonomyId: e.target.value || null })}
        >
          <option value="">— No term filter —</option>
          {taxonomies.map((taxonomy) => (
            <option key={taxonomy.id} value={taxonomy.id}>
              {taxonomy.name_plural}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor={`${id}-date`} className="block text-sm font-medium">
          Date field
        </label>
        <p id={`${id}-date-hint`} className="mt-0.5 text-xs text-content-subtle">
          Which date decides “still to come”, and what “soonest first” orders by — an event’s start
          date, not the day it was published. Without one, the listing offers neither.
        </p>
        <select
          id={`${id}-date`}
          aria-describedby={`${id}-date-hint`}
          className={inputClass}
          value={typeof config.dateFieldApiId === 'string' ? config.dateFieldApiId : ''}
          onChange={(e) => onChange({ ...config, dateFieldApiId: e.target.value || null })}
        >
          <option value="">— No date filter —</option>
          {dateFields.map((field) => (
            <option key={field.api_id} value={field.api_id}>
              {field.label}
            </option>
          ))}
        </select>
        {target && dateFields.length === 0 && (
          <p className="mt-1.5 text-xs text-content-subtle">
            That type has no date fields, so there is nothing to filter or order by yet.
          </p>
        )}
      </div>

      <Row>
        <NumberInput
          label="Results by default"
          hint="What a newly placed block asks for."
          value={config.defaultLimit}
          onChange={(defaultLimit) => onChange({ ...config, defaultLimit })}
        />
        <NumberInput
          label="Most an editor may ask for"
          hint="A ceiling, not a limit. Asking for more is quietly reduced to this."
          value={config.maxResults}
          onChange={(maxResults) => onChange({ ...config, maxResults })}
        />
      </Row>

      <p className="rounded-md border border-border bg-surface-sunken px-3 py-2.5 text-xs text-content-subtle">
        A query stores the rule, never the answer. Results are worked out fresh on every page view,
        so publishing a new item adds it to every listing that matches without anyone editing a
        page.
      </p>
    </div>
  );
};

const BlockConfig: ConfigForm = ({ config, onChange, blockTypes = [] }) => {
  const allowed = Array.isArray(config.allowedBlocks) ? (config.allowedBlocks as string[]) : [];

  const toggle = (apiId: string, checked: boolean) =>
    onChange({
      ...config,
      allowedBlocks: checked ? [...allowed, apiId] : allowed.filter((entry) => entry !== apiId),
    });

  return (
    <div className="space-y-4">
      {blockTypes.length === 0 ? (
        <p className="rounded-md border border-border bg-surface-sunken px-3 py-2.5 text-xs text-content-subtle">
          No block types exist yet. Create some under Settings → Block types, then come back and
          choose which of them belong in this region — the field can be saved meanwhile and will
          accept any block type.
        </p>
      ) : (
        <fieldset>
          <legend className="text-sm font-medium">Allowed blocks</legend>
          {/*
            An empty selection means "any", which is the field config's documented default. Said
            out loud here because an empty checkbox group otherwise reads as "none allowed" — the
            opposite of what it does.
          */}
          <p className="mt-0.5 text-xs text-content-subtle">
            {allowed.length === 0
              ? 'Nothing selected, so every block type is allowed here.'
              : `${allowed.length} of ${blockTypes.length} block types allowed.`}
          </p>

          <div className="mt-2 space-y-1.5 rounded-md border border-border-strong bg-surface px-3 py-2.5">
            {blockTypes.map((blockType) => (
              <div key={blockType.id} className="flex items-center gap-2">
                <input
                  id={`allowed-${blockType.api_id}`}
                  type="checkbox"
                  checked={allowed.includes(blockType.api_id)}
                  onChange={(e) => toggle(blockType.api_id, e.target.checked)}
                />
                <label htmlFor={`allowed-${blockType.api_id}`} className="text-sm">
                  {blockType.name}
                </label>
              </div>
            ))}
          </div>
        </fieldset>
      )}

      <NumberInput
        label="Maximum blocks"
        hint="Leave blank for no limit."
        min={1}
        value={config.maxBlocks}
        onChange={(maxBlocks) => onChange({ ...config, maxBlocks })}
      />
    </div>
  );
};

/**
 * A repeater's shape: the sub-fields one row is made of.
 *
 * The sub-field editor is deliberately shallower than the top-level field builder — a label, an
 * api_id, a type, and required. Per-type options are reached through the *same* `FieldConfigForm`
 * this file exports, recursing one level, so a select sub-field gets the real options editor and a
 * media sub-field gets the real accept list rather than a second, poorer copy of each.
 *
 * That recursion terminates because `REPEATER_SUB_FIELD_TYPES` excludes `repeater` itself. It is
 * worth noticing that the recursion is safe *because of a rule in core*, not because of anything
 * here — which is why that rule is an allowlist rather than a filter.
 */
const RepeaterConfig: ConfigForm = ({ config, onChange, ...rest }) => {
  const id = useId();
  const subFields = Array.isArray(config.fields)
    ? (config.fields as Record<string, unknown>[])
    : [];

  const update = (next: Record<string, unknown>[]) => onChange({ ...config, fields: next });

  const patch = (index: number, changes: Record<string, unknown>) =>
    update(subFields.map((sub, position) => (position === index ? { ...sub, ...changes } : sub)));

  const move = (from: number, to: number) => {
    if (to < 0 || to >= subFields.length) return;
    const next = [...subFields];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    update(next);
  };

  return (
    <div className="space-y-4">
      <Row>
        <NumberInput
          label="Minimum entries"
          value={config.minItems}
          onChange={(minItems) => onChange({ ...config, minItems: minItems ?? 0 })}
          min={0}
        />
        <NumberInput
          label="Maximum entries"
          value={config.maxItems}
          onChange={(maxItems) => onChange({ ...config, maxItems })}
          min={1}
        />
      </Row>

      <fieldset>
        <legend className="text-sm font-medium">Fields in each entry</legend>
        <p className="mt-0.5 text-xs text-content-subtle">
          Every entry gets one of each. Order here is the order an editor fills them in.
        </p>

        {subFields.length === 0 ? (
          <p className="mt-2 rounded-md border border-dashed border-border px-3 py-2.5 text-xs text-content-subtle">
            None yet. A repeater with no fields has nothing to repeat, and the editor says so
            rather than offering rows with nowhere to type.
          </p>
        ) : (
          <ol className="mt-2 space-y-3">
            {subFields.map((sub, index) => {
              const subType = (typeof sub.type === 'string' ? sub.type : 'text') as FieldType;
              const rowId = `${id}-${index}`;

              return (
                <li key={index} className="rounded-lg border border-border bg-surface p-3">
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="min-w-36 flex-1">
                      <label htmlFor={`${rowId}-label`} className="block text-xs font-medium">
                        Label
                      </label>
                      <input
                        id={`${rowId}-label`}
                        value={typeof sub.label === 'string' ? sub.label : ''}
                        onChange={(event) => {
                          /**
                           * The api_id follows the label until it is edited by hand, exactly as the
                           * top-level builder does — but only while it still matches, so renaming a
                           * label later cannot silently change a key that stored values are under.
                           */
                          const label = event.target.value;
                          const derived = slugifyApiId(label);
                          const following =
                            !sub.api_id || sub.api_id === slugifyApiId(String(sub.label ?? ''));
                          patch(index, following ? { label, api_id: derived } : { label });
                        }}
                        className="mt-1 w-full rounded-md border border-border-strong bg-surface-raised px-3 py-1.5 text-sm"
                      />
                    </div>

                    <div className="min-w-32 flex-1">
                      <label htmlFor={`${rowId}-api`} className="block text-xs font-medium">
                        API id
                      </label>
                      <input
                        id={`${rowId}-api`}
                        value={typeof sub.api_id === 'string' ? sub.api_id : ''}
                        onChange={(event) => patch(index, { api_id: slugifyApiId(event.target.value) })}
                        className="mt-1 w-full rounded-md border border-border-strong bg-surface-raised px-3 py-1.5 font-mono text-sm"
                      />
                    </div>

                    <div>
                      <label htmlFor={`${rowId}-type`} className="block text-xs font-medium">
                        Type
                      </label>
                      <select
                        id={`${rowId}-type`}
                        value={subType}
                        onChange={(event) =>
                          // The config goes with the type: options belong to a select and mean
                          // nothing to a date, and carrying them over would fail validation.
                          patch(index, { type: event.target.value, config: {} })
                        }
                        className="mt-1 rounded-md border border-border-strong bg-surface-raised px-3 py-1.5 text-sm"
                      >
                        {REPEATER_SUB_FIELD_TYPES.map((option) => (
                          <option key={option} value={option}>
                            {FIELD_TYPE_META[option].label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="flex items-center gap-1 pb-1">
                      <label className="flex items-center gap-1.5 text-xs">
                        <input
                          type="checkbox"
                          checked={sub.required === true}
                          onChange={(event) => patch(index, { required: event.target.checked })}
                        />
                        Required
                      </label>
                    </div>

                    <div className="flex gap-1 pb-1">
                      <SubFieldButton
                        label={`Move ${String(sub.label ?? 'field')} up`}
                        disabled={index === 0}
                        onClick={() => move(index, index - 1)}
                      >
                        ↑
                      </SubFieldButton>
                      <SubFieldButton
                        label={`Move ${String(sub.label ?? 'field')} down`}
                        disabled={index === subFields.length - 1}
                        onClick={() => move(index, index + 1)}
                      >
                        ↓
                      </SubFieldButton>
                      <SubFieldButton
                        label={`Remove ${String(sub.label ?? 'field')}`}
                        onClick={() =>
                          update(subFields.filter((_, position) => position !== index))
                        }
                      >
                        ×
                      </SubFieldButton>
                    </div>
                  </div>

                  {/*
                    A sub-field's condition names another sub-field in the same row, never a field
                    on the item around it — the row is the scope `validateRepeater` recurses with.
                    Stored as the condition object rather than a JSON string, because this whole
                    definition already lives inside the repeater's config.
                  */}
                  <div className="mt-3 border-t border-border pt-3">
                    <VisibilityEditor
                      idPrefix={rowId}
                      value={(sub.visible_when as VisibilityCondition | null) ?? null}
                      siblings={subFields
                        .filter((_, position) => position !== index)
                        .map((candidate) => ({
                          api_id: String(candidate.api_id ?? ''),
                          label: String(candidate.label ?? candidate.api_id ?? ''),
                          type: (typeof candidate.type === 'string'
                            ? candidate.type
                            : 'text') as FieldType,
                        }))
                        .filter((candidate) => candidate.api_id !== '')}
                      onChange={(visible_when) => patch(index, { visible_when })}
                    />
                  </div>

                  <div className="mt-3 border-t border-border pt-3">
                    <FieldConfigForm
                      type={subType}
                      config={(sub.config as Record<string, unknown>) ?? {}}
                      onChange={(subConfig) => patch(index, { config: subConfig })}
                      {...rest}
                    />
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        <button
          type="button"
          onClick={() =>
            update([...subFields, { api_id: '', label: '', type: 'text', required: false, config: {} }])
          }
          className="mt-3 rounded-md border border-border-strong px-3 py-1.5 text-sm font-medium transition-colors hover:bg-surface-sunken"
        >
          + Add field
        </button>
      </fieldset>
    </div>
  );
};

function SubFieldButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="rounded-md border border-border px-2 py-1 text-xs text-content-muted transition-colors hover:bg-surface-sunken hover:text-content disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/** The same shape core's `api_id` validation accepts: lowercase, digits, underscores. */
function slugifyApiId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

/**
 * The registry. Keys must cover every member of `FIELD_TYPES` from core — there is a test for it.
 */
export const fieldConfigForms: Record<FieldType, ConfigForm> = {
  text: TextConfig,
  richtext: RichtextConfig,
  number: NumberConfig,
  boolean: BooleanConfig,
  date: DateConfig,
  select: SelectConfig,
  media: MediaConfig,
  taxonomy: TaxonomyConfig,
  relation: RelationConfig,
  link: LinkConfig,
  snippet: SnippetConfig,
  embed: EmbedConfig,
  block: BlockConfig,
  repeater: RepeaterConfig,
  query: QueryConfig,
};

export function FieldConfigForm({ type, ...props }: ConfigFormProps & { type: FieldType }) {
  const Form = fieldConfigForms[type];
  return Form ? <Form {...props} /> : null;
}

export default FieldConfigForm;
