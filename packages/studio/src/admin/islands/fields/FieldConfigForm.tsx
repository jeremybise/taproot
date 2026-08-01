import { useId } from 'react';
import {
  FIELD_TYPE_META,
  REPEATER_SUB_FIELD_TYPES,
  type ContentTypeRow,
  type FieldType,
  type TaxonomyRow,
} from '@taproot/core';

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

function Row({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2">{children}</div>;
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
    <p className="rounded-md border border-border bg-surface-sunken px-3 py-2.5 text-xs text-content-subtle">
      Toolbar and allowed-format options arrive with the rich-text editor in the next tranche.
      Restricting formats is also what keeps heading order sane for the Phase 4 accessibility
      checker.
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

      <p className="rounded-md border border-border bg-surface-sunken px-3 py-2.5 text-xs text-content-subtle">
        The reference picker for content items arrives in the taxonomies and relations tranche.
        Configuring the field now is safe — the definition is stored and validated.
      </p>
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
  block: BlockConfig,
  repeater: RepeaterConfig,
};

export function FieldConfigForm({ type, ...props }: ConfigFormProps & { type: FieldType }) {
  const Form = fieldConfigForms[type];
  return Form ? <Form {...props} /> : null;
}

export default FieldConfigForm;
