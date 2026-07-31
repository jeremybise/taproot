import { useId } from 'react';
import {
  FIELD_TYPES,
  FIELD_TYPE_META,
  fieldTypeIsDeferred,
  type FieldType,
} from '@taproot/core';

/**
 * Choose a field type.
 *
 * A radio group rather than a `<select>`: each type's description is what tells a non-technical
 * editor whether they want "Text" or "Rich text", and a dropdown hides all of them until opened.
 * Native radios also give arrow-key navigation and correct grouping semantics for free.
 */
export function FieldTypePicker({
  value,
  onChange,
  disabled = false,
}: {
  value: FieldType;
  onChange: (type: FieldType) => void;
  disabled?: boolean;
}) {
  const name = useId();

  return (
    <fieldset disabled={disabled}>
      <legend className="text-sm font-medium">Field type</legend>
      {disabled && (
        <p className="mt-0.5 text-xs text-content-subtle">
          A field's type cannot be changed after it is created — it would reinterpret every value
          already stored. Delete the field and add a new one to change it.
        </p>
      )}

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {FIELD_TYPES.map((type) => {
          const meta = FIELD_TYPE_META[type];
          const id = `${name}-${type}`;
          const selected = value === type;

          return (
            <div
              key={type}
              className={`flex gap-2.5 rounded-md border px-3 py-2.5 ${
                selected ? 'border-accent bg-accent-subtle' : 'border-border bg-surface-raised'
              } ${disabled ? 'opacity-70' : ''}`}
            >
              <input
                id={id}
                type="radio"
                name={name}
                value={type}
                checked={selected}
                onChange={() => onChange(type)}
                aria-describedby={`${id}-hint`}
                className="mt-1"
              />
              <div className="min-w-0">
                <label htmlFor={id} className="block text-sm font-medium">
                  {meta.label}
                  {fieldTypeIsDeferred(type) && (
                    /*
                      Badged by what is actually true, not by which phase a plan assigned it to.
                      Every type used to carry a "Phase N" chip, so an editor was told that rich
                      text, media, taxonomy, and blocks were still coming long after they shipped.
                    */
                    <span className="ml-1.5 rounded-full border border-border px-1.5 py-0.5 text-[0.6875rem] font-normal text-content-muted">
                      No editor yet
                    </span>
                  )}
                </label>
                <p id={`${id}-hint`} className="text-xs text-content-subtle">
                  {meta.description}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

export default FieldTypePicker;
