import {
  OPERATORS_TAKING_VALUE,
  VISIBILITY_OPERATORS,
  type FieldType,
  type VisibilityCondition,
  type VisibilityOperator,
} from '@taprootcms/core';

/**
 * "Show this field when …" — the builder half of conditional visibility.
 *
 * One condition, not a rule set. AND/OR turns this into a query builder inside the field builder
 * for a case nobody has yet, and a second condition can be added later without moving the first
 * where unpicking an expression tree could not be.
 */

export interface SiblingOption {
  api_id: string;
  label: string;
  type: FieldType;
}

/**
 * Worded as an editor would say it, not as the operator is spelled.
 *
 * `equals` reads "is" because the sentence it completes is "show this field when Status is
 * Published" — "equals" is how a programmer says it and "is" is how everyone else does.
 */
const OPERATOR_LABELS: Record<VisibilityOperator, string> = {
  is_checked: 'is checked',
  is_not_checked: 'is not checked',
  equals: 'is',
  not_equals: 'is not',
  is_set: 'has a value',
  is_empty: 'is empty',
};

/**
 * Operators worth offering for a given field type.
 *
 * A checkbox has no useful "is" — it has two states and both are already spelled — while a text
 * field has no useful "is checked". Offering all six for everything means five of them are wrong on
 * any given field, and the one somebody picks by accident produces a field that never appears.
 */
function operatorsFor(type: FieldType | undefined): VisibilityOperator[] {
  if (type === 'boolean') return ['is_checked', 'is_not_checked'];
  return VISIBILITY_OPERATORS.filter(
    (operator) => operator !== 'is_checked' && operator !== 'is_not_checked',
  );
}

/** The operator a newly chosen field should start on — the one that is right far more often. */
function defaultOperator(type: FieldType | undefined): VisibilityOperator {
  return type === 'boolean' ? 'is_checked' : 'equals';
}

export function VisibilityEditor({
  idPrefix,
  value,
  siblings,
  onChange,
}: {
  /** Distinguishes these controls from another copy of them — a repeater's config form nests one. */
  idPrefix: string;
  value: VisibilityCondition | null;
  /** Fields at the same level, excluding this one. The only scope a condition may name. */
  siblings: SiblingOption[];
  onChange: (next: VisibilityCondition | null) => void;
}) {
  const chosen = siblings.find((sibling) => sibling.api_id === value?.field);
  const operators = operatorsFor(chosen?.type);
  const takesValue = value ? OPERATORS_TAKING_VALUE.includes(value.operator) : false;

  if (siblings.length === 0) {
    return (
      <p className="text-xs text-content-subtle">
        A condition names another field on this type, and this is the only one so far. Add a second
        field and this becomes available.
      </p>
    );
  }

  return (
    <div className="@container">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <label htmlFor={`${idPrefix}-when-field`} className="block text-xs font-medium">
            Show this field when
          </label>
          <select
            id={`${idPrefix}-when-field`}
            value={value?.field ?? ''}
            onChange={(event) => {
              const field = event.target.value;
              if (!field) return onChange(null);

              const type = siblings.find((sibling) => sibling.api_id === field)?.type;
              /*
                The operator is re-derived rather than carried over: switching from a checkbox to a
                text field would otherwise leave `is_checked` selected against a field that can
                never be checked, and the control would look settled while the field never appeared.
              */
              onChange({ field, operator: defaultOperator(type) });
            }}
            className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm"
          >
            <option value="">Always shown</option>
            {siblings.map((sibling) => (
              <option key={sibling.api_id} value={sibling.api_id}>
                {sibling.label}
              </option>
            ))}
          </select>
        </div>

        {value && (
          <>
            <div className="min-w-0 flex-1">
              <label htmlFor={`${idPrefix}-when-operator`} className="block text-xs font-medium">
                Condition
              </label>
              <select
                id={`${idPrefix}-when-operator`}
                value={value.operator}
                onChange={(event) => {
                  const operator = event.target.value as VisibilityOperator;
                  onChange({
                    field: value.field,
                    operator,
                    // Dropped when the new operator does not read it, so a stale comparison value
                    // cannot sit in the stored condition doing nothing.
                    ...(OPERATORS_TAKING_VALUE.includes(operator)
                      ? { value: value.value ?? '' }
                      : {}),
                  });
                }}
                className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm"
              >
                {operators.map((operator) => (
                  <option key={operator} value={operator}>
                    {OPERATOR_LABELS[operator]}
                  </option>
                ))}
              </select>
            </div>

            {takesValue && (
              <div className="min-w-0 flex-1">
                <label htmlFor={`${idPrefix}-when-value`} className="block text-xs font-medium">
                  Value
                </label>
                <input
                  id={`${idPrefix}-when-value`}
                  value={value.value ?? ''}
                  onChange={(event) =>
                    onChange({ ...value, value: event.target.value })
                  }
                  className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm"
                />
              </div>
            )}
          </>
        )}
      </div>

      {value && (
        <p className="mt-2 text-xs text-content-subtle">
          Hidden fields keep whatever is already stored in them — switching the condition off and on
          again brings the value back. What your site renders is still its own decision.
        </p>
      )}
    </div>
  );
}

export default VisibilityEditor;
