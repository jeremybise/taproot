import { useId, useState } from 'react';
import { FIELD_TYPE_META, type ContentStatus, type FieldRow } from '@taproot/core';

/**
 * The content item editor.
 *
 * Renders one input per field from the content type's schema. Phase 1 replaces the richtext,
 * media, relation, and taxonomy placeholders with real editors; the save contract does not change
 * when it does.
 *
 * Server-side validation errors come back keyed by field `api_id`, which is what lets each message
 * be rendered next to its own input and wired up with `aria-describedby` rather than dumped in a
 * single summary at the top.
 */

interface Props {
  itemId?: string;
  contentTypeId: string;
  contentTypeName: string;
  fields: FieldRow[];
  initial: {
    title: string;
    slug: string;
    status: ContentStatus;
    parentId: string | null;
    data: Record<string, unknown>;
  };
  /** Candidate parents for hierarchical types. Empty for collections and singletons. */
  parents: { id: string; title: string; path: string }[];
  canPublish: boolean;
  isHierarchical: boolean;
}

const STATUSES: { value: ContentStatus; label: string; needsPublish: boolean }[] = [
  { value: 'draft', label: 'Draft', needsPublish: false },
  { value: 'in_review', label: 'In review', needsPublish: false },
  { value: 'published', label: 'Published', needsPublish: true },
  { value: 'archived', label: 'Archived', needsPublish: true },
];

export default function ItemEditor({
  itemId,
  contentTypeId,
  contentTypeName,
  fields,
  initial,
  parents,
  canPublish,
  isHierarchical,
}: Props) {
  const [title, setTitle] = useState(initial.title);
  const [slug, setSlug] = useState(initial.slug);
  const [status, setStatus] = useState<ContentStatus>(initial.status);
  const [parentId, setParentId] = useState<string | null>(initial.parentId);
  const [data, setData] = useState<Record<string, unknown>>(initial.data);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formId = useId();

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setErrors({});
    setMessage(null);

    const payload = { title, slug, status, parentId, data };
    const url = itemId ? `/api/taproot/items/${itemId}` : '/api/taproot/items';

    try {
      const response = await fetch(url, {
        method: itemId ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(itemId ? payload : { ...payload, contentTypeId }),
      });

      const body = (await response.json().catch(() => null)) as {
        item?: { id: string; path: string };
        error?: string;
        fields?: Record<string, string[]>;
      } | null;

      if (!response.ok) {
        setErrors(body?.fields ?? {});
        setMessage(body?.error ?? `Save failed (${response.status}).`);
        return;
      }

      if (!itemId && body?.item) {
        window.location.href = `/admin/content/${body.item.id}?saved=1`;
        return;
      }

      setMessage('Saved.');
      if (body?.item) setSlug(body.item.path.split('/').pop() ?? slug);
    } catch {
      setMessage('Could not reach the server. Your changes have not been saved.');
    } finally {
      setBusy(false);
    }
  }

  function setValue(apiId: string, value: unknown) {
    setData((current) => ({ ...current, [apiId]: value }));
  }

  return (
    <form onSubmit={save} className="grid gap-8 lg:grid-cols-[1fr_18rem]">
      <div className="min-w-0 space-y-6">
        <div role="alert" aria-live="assertive">
          {message && (
            <p
              className={`rounded-md border px-4 py-3 text-sm ${
                message === 'Saved.'
                  ? 'border-accent bg-accent-subtle'
                  : 'border-danger bg-danger-subtle'
              }`}
            >
              {message}
            </p>
          )}
        </div>

        <div>
          <label htmlFor={`${formId}-title`} className="block text-sm font-medium">
            Title
          </label>
          <input
            id={`${formId}-title`}
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label htmlFor={`${formId}-slug`} className="block text-sm font-medium">
            Slug
          </label>
          <p id={`${formId}-slug-hint`} className="mt-0.5 text-xs text-content-subtle">
            The last part of the URL. Changing it moves the page and leaves a redirect behind
            automatically.
          </p>
          <input
            id={`${formId}-slug`}
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            aria-describedby={`${formId}-slug-hint`}
            placeholder="Derived from the title"
            className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 font-mono text-sm"
          />
        </div>

        <section aria-labelledby={`${formId}-fields`} className="space-y-6">
          <h2 id={`${formId}-fields`} className="text-base font-semibold">
            {contentTypeName} fields
          </h2>

          {fields.length === 0 && (
            <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-content-muted">
              This content type has no fields yet.
            </p>
          )}

          {fields.map((field) => (
            <FieldInput
              key={field.id}
              field={field}
              value={data[field.api_id]}
              errors={errors[field.api_id]}
              onChange={(value) => setValue(field.api_id, value)}
            />
          ))}
        </section>
      </div>

      {/* Sidebar ---------------------------------------------------------- */}
      <aside className="space-y-6">
        <div className="rounded-lg border border-border bg-surface-raised p-4">
          <h2 className="text-sm font-semibold">Publishing</h2>

          <div className="mt-3">
            <label htmlFor={`${formId}-status`} className="block text-sm font-medium">
              Status
            </label>
            <select
              id={`${formId}-status`}
              value={status}
              onChange={(e) => setStatus(e.target.value as ContentStatus)}
              className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm"
            >
              {STATUSES.map((option) => (
                <option
                  key={option.value}
                  value={option.value}
                  disabled={option.needsPublish && !canPublish}
                >
                  {option.label}
                  {option.needsPublish && !canPublish ? ' (needs editor role)' : ''}
                </option>
              ))}
            </select>
            {!canPublish && (
              <p className="mt-1.5 text-xs text-content-subtle">
                Your role can save drafts and submit for review. An editor publishes.
              </p>
            )}
          </div>

          {isHierarchical && (
            <div className="mt-4">
              <label htmlFor={`${formId}-parent`} className="block text-sm font-medium">
                Parent page
              </label>
              <select
                id={`${formId}-parent`}
                value={parentId ?? ''}
                onChange={(e) => setParentId(e.target.value || null)}
                className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm"
              >
                <option value="">— Top level —</option>
                {parents.map((parent) => (
                  <option key={parent.id} value={parent.id}>
                    {parent.path}
                  </option>
                ))}
              </select>
              <p className="mt-1.5 text-xs text-content-subtle">
                Moving a page rewrites the URLs of everything beneath it and leaves redirects.
              </p>
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="mt-5 w-full rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-accent-content transition-colors hover:bg-accent-hover disabled:opacity-60"
          >
            {busy ? 'Saving…' : itemId ? 'Save changes' : 'Create item'}
          </button>
        </div>
      </aside>
    </form>
  );
}

function FieldInput({
  field,
  value,
  errors,
  onChange,
}: {
  field: FieldRow;
  value: unknown;
  errors?: string[];
  onChange: (value: unknown) => void;
}) {
  const id = `field-${field.id}`;
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const config = JSON.parse(field.config || '{}') as Record<string, unknown>;

  const describedBy = [field.help_text ? hintId : null, errors?.length ? errorId : null]
    .filter(Boolean)
    .join(' ');

  const shared = {
    id,
    required: field.required === 1,
    'aria-describedby': describedBy || undefined,
    'aria-invalid': errors?.length ? (true as const) : undefined,
    className: `mt-1.5 w-full rounded-md border bg-surface px-3 py-2 text-sm ${
      errors?.length ? 'border-danger' : 'border-border-strong'
    }`,
  };

  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">
        {field.label}
        {field.required === 1 && (
          <span className="ml-1 text-danger" aria-hidden="true">
            *
          </span>
        )}
        {field.required === 1 && <span className="sr-only-focusable"> (required)</span>}
      </label>

      {field.help_text && (
        <p id={hintId} className="mt-0.5 text-xs text-content-subtle">
          {field.help_text}
        </p>
      )}

      {renderControl()}

      {errors?.length ? (
        <p id={errorId} className="mt-1.5 text-sm text-danger">
          {errors.join(' ')}
        </p>
      ) : null}
    </div>
  );

  function renderControl() {
    switch (field.type) {
      case 'text':
        return config.multiline ? (
          <textarea
            {...shared}
            rows={4}
            value={(value as string) ?? ''}
            onChange={(e) => onChange(e.target.value || null)}
          />
        ) : (
          <input
            {...shared}
            type="text"
            value={(value as string) ?? ''}
            onChange={(e) => onChange(e.target.value || null)}
          />
        );

      case 'number':
        return (
          <input
            {...shared}
            type="number"
            value={value === null || value === undefined ? '' : String(value)}
            onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          />
        );

      case 'boolean':
        return (
          <div className="mt-1.5 flex items-center gap-2">
            <input
              id={id}
              type="checkbox"
              checked={Boolean(value)}
              aria-describedby={describedBy || undefined}
              onChange={(e) => onChange(e.target.checked)}
            />
            <span className="text-sm text-content-muted">Enabled</span>
          </div>
        );

      case 'date':
        return (
          <input
            {...shared}
            type={config.includeTime ? 'datetime-local' : 'date'}
            value={toDateInputValue(value, Boolean(config.includeTime))}
            onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)}
          />
        );

      case 'select': {
        const options = (config.options as { label: string; value: string }[] | undefined) ?? [];
        return (
          <select
            {...shared}
            value={(value as string) ?? ''}
            onChange={(e) => onChange(e.target.value || null)}
          >
            <option value="">— None —</option>
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        );
      }

      case 'richtext':
        // Phase 1 swaps this for a real editor. A plain textarea still stores and round-trips the
        // value correctly in the meantime, so no content is lost by using it now.
        return (
          <textarea
            {...shared}
            rows={8}
            value={(value as string) ?? ''}
            onChange={(e) => onChange(e.target.value || null)}
          />
        );

      default:
        return (
          <p className="mt-1.5 rounded-md border border-dashed border-border px-3 py-2.5 text-sm text-content-subtle">
            The {FIELD_TYPE_META[field.type].label.toLowerCase()} editor arrives in Phase{' '}
            {FIELD_TYPE_META[field.type].availableIn}. Values already stored for this field are kept
            and are not modified by saving.
          </p>
        );
    }
  }
}

function toDateInputValue(value: unknown, includeTime: boolean): string {
  if (typeof value !== 'string' || !value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return includeTime ? date.toISOString().slice(0, 16) : date.toISOString().slice(0, 10);
}
