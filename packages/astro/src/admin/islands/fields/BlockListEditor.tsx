import { useEffect, useId, useRef, useState } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from '@dnd-kit/core';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronDown, ChevronUp, GripVertical, Library, Link2Off, Trash2 } from 'lucide-react';

import type { MediaOption } from '../../mediaOptions.js';
import { newId, type BlockInstance, type ContentTypeRow, type FieldRow } from '@taproot/core';

import { FieldControl, type TermOption } from './FieldControl.js';

/**
 * The editor for a `block` field: a page's composed regions.
 *
 * Each entry is one block instance â€” a block type plus its own field values â€” and the field's value
 * is the ordered list of them. Order is the whole point, so it is reorderable by dragging **and** by
 * Move up / Move down buttons, following the field builder's precedent: the buttons are the primary
 * keyboard path, not a fallback, because nothing tells a keyboard user that dnd-kit's
 * space-then-arrows does anything.
 *
 * Each block's fields render through `FieldControl`, the same component the item editor uses for
 * top-level fields. That is what stops a block's text input from behaving differently to a page's,
 * and it means every field type works inside a block the day it works outside one.
 */

export interface BlockTypeOption extends ContentTypeRow {
  fields: FieldRow[];
}

/** A library entry, as offered in the "From the library" list. */
export interface ReusableBlockOption {
  id: string;
  name: string;
  block_type: string;
  data: Record<string, unknown>;
}

interface Props {
  value: BlockInstance[];
  onChange: (blocks: BlockInstance[]) => void;
  /** Block types this field permits, already filtered by `allowedBlocks`. */
  blockTypes: BlockTypeOption[];
  maxBlocks?: number;
  termsByTaxonomy?: Record<string, TermOption[]>;
  /** Passed through so a block's own media field works exactly as a page's does. */
  media?: MediaOption[];
  /** Library entries placeable in this field, already filtered to allowed block types. */
  reusableBlocks?: ReusableBlockOption[];
  /** Promoting to the library needs the editor role, so the control is hidden below it. */
  canPromote?: boolean;
  labelledBy: string;
  disabled?: boolean;
}

export function BlockListEditor({
  value,
  onChange,
  blockTypes,
  maxBlocks,
  termsByTaxonomy,
  media,
  reusableBlocks = [],
  canPromote = false,
  labelledBy,
  disabled = false,
}: Props) {
  const id = useId();
  const [status, setStatus] = useState('');
  const [promoting, setPromoting] = useState<string | null>(null);
  /** Blocks collapse to a summary row once there are several; a page can hold a lot of them. */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // False during SSR and the first client render, so both produce identical HTML. dnd-kit derives
  // ids from a module-level counter and would otherwise cause a hydration mismatch.
  const [draggable, setDraggable] = useState(false);
  useEffect(() => setDraggable(true), []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const byApiId = new Map(blockTypes.map((type) => [type.api_id, type]));
  const atLimit = maxBlocks !== undefined && value.length >= maxBlocks;

  function move(from: number, to: number) {
    if (to < 0 || to >= value.length) return;
    const next = [...value];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    onChange(next);
    setStatus(
      `${byApiId.get(moved!.type)?.name ?? moved!.type} moved to position ${to + 1} of ${next.length}.`,
    );
  }

  function add(apiId: string) {
    const blockType = byApiId.get(apiId);
    if (!blockType) return;

    /**
     * Defaults come from the field definitions, not from an empty object.
     *
     * A block added with `{}` would fail validation the moment any of its fields is required, and
     * the editor would show an error for something they have not touched yet.
     */
    const data: Record<string, unknown> = {};
    for (const field of blockType.fields) {
      const config = safeParse(field.config);
      if (config.defaultValue !== undefined) data[field.api_id] = config.defaultValue;
    }

    onChange([...value, { id: newId(), type: apiId, data }]);
    setStatus(`${blockType.name} added at position ${value.length + 1}.`);
  }

  function addReference(entry: ReusableBlockOption) {
    onChange([...value, { id: newId(), type: entry.block_type, data: {}, ref: entry.id }]);
    setStatus(`${entry.name} added from the library at position ${value.length + 1}.`);
  }

  function remove(index: number) {
    const block = value[index]!;
    onChange(value.filter((_, i) => i !== index));
    setStatus(`${byApiId.get(block.type)?.name ?? block.type} removed.`);
  }

  /**
   * Promote a block into the library, then replace it with a reference to the new entry.
   *
   * Replacing rather than leaving a copy behind is the point: if the block stayed as content, the
   * page would keep its own version and the library entry would drift away from it â€” and nobody
   * would find out until the two disagreed on a page nobody had reopened.
   */
  async function promote(index: number) {
    const block = value[index]!;
    const name = window.prompt(
      'Name this reusable block. Editors will find it in the library by this name.',
      byApiId.get(block.type)?.name ?? block.type,
    );
    if (!name?.trim()) return;

    setPromoting(block.id);
    try {
      const response = await fetch('/api/taproot/reusable-blocks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), blockType: block.type, data: block.data }),
      });

      const body = (await response.json().catch(() => null)) as {
        reusableBlock?: { id: string; name: string };
        error?: string;
      } | null;

      if (!response.ok || !body?.reusableBlock) {
        setStatus(body?.error ?? `Could not save to the library (${response.status}).`);
        return;
      }

      onChange(
        value.map((entry, i) =>
          i === index ? { ...entry, data: {}, ref: body.reusableBlock!.id } : entry,
        ),
      );
      setStatus(`Saved to the library as "${body.reusableBlock.name}". This page now references it.`);
    } catch {
      setStatus('Could not reach the server. Nothing was saved to the library.');
    } finally {
      setPromoting(null);
    }
  }

  /** Detach a reference, copying today's library content back onto the page as ordinary content. */
  function detach(index: number) {
    const block = value[index]!;
    const entry = reusableBlocks.find((candidate) => candidate.id === block.ref);

    onChange(
      value.map((current, i) =>
        i === index ? { id: current.id, type: current.type, data: entry?.data ?? {} } : current,
      ),
    );
    setStatus('Detached from the library. This page now has its own copy.');
  }

  function update(index: number, data: Record<string, unknown>) {
    onChange(value.map((block, i) => (i === index ? { ...block, data } : block)));
  }

  function toggleCollapsed(blockId: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(blockId)) next.delete(blockId);
      else next.add(blockId);
      return next;
    });
  }

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    move(
      value.findIndex((block) => block.id === active.id),
      value.findIndex((block) => block.id === over.id),
    );
  }

  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up block ${position(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over ? `Block ${position(active.id)} moved over position ${position(over.id)}.` : '',
    onDragEnd: ({ active, over }) =>
      over ? `Block dropped at position ${position(over.id)}.` : 'Block returned to its position.',
    onDragCancel: () => 'Reordering cancelled.',
  };

  function position(blockId: string | number) {
    return value.findIndex((block) => block.id === blockId) + 1;
  }

  const list = (
    <ol aria-labelledby={labelledBy} className="mt-1.5 space-y-3">
      {value.map((block, index) => (
        <BlockRow
          key={block.id}
          block={block}
          index={index}
          total={value.length}
          blockType={byApiId.get(block.type)}
          collapsed={collapsed.has(block.id)}
          draggable={draggable && !disabled}
          disabled={disabled}
          termsByTaxonomy={termsByTaxonomy}
          media={media}
          reusable={block.ref ? reusableBlocks.find((e) => e.id === block.ref) : undefined}
          canPromote={canPromote && !disabled}
          promoting={promoting === block.id}
          onToggle={() => toggleCollapsed(block.id)}
          onMoveUp={() => move(index, index - 1)}
          onMoveDown={() => move(index, index + 1)}
          onRemove={() => remove(index)}
          onPromote={() => promote(index)}
          onDetach={() => detach(index)}
          onChange={(data) => update(index, data)}
        />
      ))}
    </ol>
  );

  return (
    <div>
      {value.length === 0 ? (
        <p className="mt-1.5 rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-content-muted">
          No blocks yet. Add one below to start composing this region.
        </p>
      ) : draggable && !disabled ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          accessibility={{ announcements }}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={value.map((b) => b.id)} strategy={verticalListSortingStrategy}>
            {list}
          </SortableContext>
        </DndContext>
      ) : (
        list
      )}

      {/* Reordering and adding change a list that is otherwise only visible. */}
      <p aria-live="polite" className="sr-only-focusable">
        {status}
      </p>

      {!disabled && (
        <div className="mt-3">
          {blockTypes.length === 0 ? (
            <p className="rounded-md border border-border bg-surface-sunken px-3 py-2.5 text-xs text-content-subtle">
              No block types are available for this field. Create some under Settings â†’ Block types.
            </p>
          ) : atLimit ? (
            <p className="text-xs text-content-subtle">
              This region holds at most {maxBlocks} block{maxBlocks === 1 ? '' : 's'}.
            </p>
          ) : (
            <fieldset>
              <legend id={`${id}-add`} className="text-xs font-medium text-content-subtle">
                Add a block
              </legend>
              {/*
                One button per block type rather than a select plus an Add button. Adding a block is
                the most common action here, and a select makes it two interactions and a decision
                about which control commits it.
              */}
              <div aria-labelledby={`${id}-add`} className="mt-1.5 flex flex-wrap gap-2">
                {blockTypes.map((blockType) => (
                  <button
                    key={blockType.id}
                    type="button"
                    onClick={() => add(blockType.api_id)}
                    className="rounded-md border border-border-strong px-3 py-1.5 text-sm font-medium transition-colors hover:bg-surface-sunken"
                  >
                    + {blockType.name}
                  </button>
                ))}
              </div>

              {reusableBlocks.length > 0 && (
                <>
                  <p id={`${id}-library`} className="mt-3 text-xs font-medium text-content-subtle">
                    From the library
                  </p>
                  {/*
                    Listed apart from the block types because placing one is a different decision:
                    it puts shared content on this page, and editing it later changes every other
                    page that uses it too.
                  */}
                  <div aria-labelledby={`${id}-library`} className="mt-1.5 flex flex-wrap gap-2">
                    {reusableBlocks.map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        onClick={() => addReference(entry)}
                        className="inline-flex items-center gap-1.5 rounded-md border border-accent bg-accent-subtle px-3 py-1.5 text-sm font-medium transition-colors hover:bg-surface-sunken"
                      >
                        <Library aria-hidden="true" size={14} />
                        {entry.name}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </fieldset>
          )}
        </div>
      )}
    </div>
  );
}

interface RowProps {
  block: BlockInstance;
  index: number;
  total: number;
  blockType?: BlockTypeOption;
  collapsed: boolean;
  draggable: boolean;
  disabled: boolean;
  termsByTaxonomy?: Record<string, TermOption[]>;
  media?: MediaOption[];
  /** The library entry this block references, when it is a reference rather than page content. */
  reusable?: ReusableBlockOption;
  canPromote: boolean;
  promoting: boolean;
  onToggle: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  onPromote: () => void;
  onDetach: () => void;
  onChange: (data: Record<string, unknown>) => void;
}

function BlockRow({
  block,
  index,
  total,
  blockType,
  collapsed,
  draggable,
  disabled,
  termsByTaxonomy,
  media,
  reusable,
  canPromote,
  promoting,
  onToggle,
  onMoveUp,
  onMoveDown,
  onRemove,
  onPromote,
  onDetach,
  onChange,
}: RowProps) {
  // Hooks must run unconditionally, so the sortable is set up even when dragging is off.
  const sortable = useSortable({ id: block.id, disabled: !draggable });
  const panelId = `block-panel-${block.id}`;
  const headingId = `block-heading-${block.id}`;

  const style = draggable
    ? { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }
    : undefined;

  const name = blockType?.name ?? block.type;

  /**
   * A block whose type has been deleted still renders, as an error rather than a blank.
   *
   * Deleting a block type in use is refused, so this is unusual â€” but if it happens, silently
   * dropping the block would delete an editor's content on the next save.
   */
  if (!blockType) {
    return (
      <li className="rounded-lg border border-danger bg-danger-subtle px-4 py-3 text-sm">
        <strong className="font-semibold">Unknown block â€œ{block.type}â€.</strong> Its type no longer
        exists. Remove it, or recreate a block type with that API id to get its content back.
        <button
          type="button"
          onClick={onRemove}
          className="ml-2 rounded-md border border-border-strong px-2 py-1 text-xs font-medium"
        >
          Remove block {index + 1}
        </button>
      </li>
    );
  }

  return (
    <li
      ref={draggable ? sortable.setNodeRef : undefined}
      style={style}
      className={`rounded-lg border bg-surface-raised ${
        sortable.isDragging ? 'border-accent opacity-80' : 'border-border'
      }`}
    >
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        {draggable && (
          <span
            {...sortable.attributes}
            {...sortable.listeners}
            aria-label={`Reorder ${name} by dragging`}
            className="cursor-grab rounded p-1 text-content-subtle hover:bg-surface-sunken"
          >
            <GripVertical aria-hidden="true" size={16} />
          </span>
        )}

        {/*
          The disclosure is the block's heading, so a screen reader moving by heading lands on the
          list of blocks in order â€” which is the structure of the page being composed.
        */}
        <h3 id={headingId} className="min-w-0 flex-1 text-sm font-medium">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!collapsed}
            aria-controls={panelId}
            className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-surface-sunken"
          >
            {collapsed ? (
              <ChevronDown aria-hidden="true" size={14} />
            ) : (
              <ChevronUp aria-hidden="true" size={14} />
            )}
            <span className="truncate">{reusable ? reusable.name : name}</span>
            {/*
              A text node *between* the spans, not inside either of them. Accessible-name
              computation trims each element's own text, so a leading space inside the second span
              disappears and the button announces as "Quote2 of 3".
            */}
            {' '}
            <span className="text-xs font-normal text-content-subtle">
              {reusable ? `shared ${name}, ` : ''}
              {index + 1} of {total}
            </span>
          </button>
        </h3>

        {!disabled && (
          <>
            {reusable ? (
              <button
                type="button"
                onClick={onDetach}
                aria-label={`Detach ${reusable.name} from the library`}
                title="Detach from the library â€” this page keeps its own copy"
                className="rounded border border-border-strong px-1.5 py-1 transition-colors hover:bg-surface-sunken"
              >
                <Link2Off aria-hidden="true" size={14} />
              </button>
            ) : (
              canPromote && (
                <button
                  type="button"
                  onClick={onPromote}
                  disabled={promoting}
                  aria-label={`Save ${name} to the library`}
                  title="Save to the library so other pages can use it"
                  className="rounded border border-border-strong px-1.5 py-1 transition-colors hover:bg-surface-sunken disabled:opacity-40"
                >
                  <Library aria-hidden="true" size={14} />
                </button>
              )
            )}
            <button
              type="button"
              onClick={onMoveUp}
              disabled={index === 0}
              aria-label={`Move ${name} up`}
              className="rounded border border-border-strong px-1.5 py-1 text-xs transition-colors hover:bg-surface-sunken disabled:opacity-40"
            >
              <span aria-hidden="true">â†‘</span>
            </button>
            <button
              type="button"
              onClick={onMoveDown}
              disabled={index === total - 1}
              aria-label={`Move ${name} down`}
              className="rounded border border-border-strong px-1.5 py-1 text-xs transition-colors hover:bg-surface-sunken disabled:opacity-40"
            >
              <span aria-hidden="true">â†“</span>
            </button>
            <button
              type="button"
              onClick={onRemove}
              aria-label={`Remove ${name}`}
              className="rounded border border-border-strong px-1.5 py-1 text-danger transition-colors hover:bg-danger-subtle"
            >
              <Trash2 aria-hidden="true" size={14} />
            </button>
          </>
        )}
      </div>

      <div id={panelId} hidden={collapsed} className="space-y-4 px-4 py-3">
        {/*
          A referenced block is shown but not edited here. Its content belongs to the library, so
          an input on this page would either edit every other page that uses it â€” a surprise from a
          screen that looks like it is editing one page â€” or quietly not save at all.
        */}
        {reusable && (
          <p className="rounded-md border border-accent bg-accent-subtle px-3 py-2 text-xs">
            Shared content from the library. Editing it changes every page that uses it, so it is
            edited in one place:{' '}
            <a href={`/admin/blocks/${reusable.id}`} className="font-medium underline">
              open â€œ{reusable.name}â€
            </a>
            .
          </p>
        )}

        {blockType.fields.length === 0 ? (
          <p className="text-sm text-content-subtle">This block type has no fields yet.</p>
        ) : (
          blockType.fields.map((field) => (
            <FieldControl
              key={field.id}
              field={field}
              value={(reusable ? reusable.data : block.data)[field.api_id]}
              termsByTaxonomy={termsByTaxonomy}
              media={media}
              preview={disabled || Boolean(reusable)}
              // Two blocks of the same type share one field definition, so the block's own id is
              // what keeps their inputs from colliding on a duplicate DOM id.
              idPrefix={block.id}
              onChange={(fieldValue) => onChange({ ...block.data, [field.api_id]: fieldValue })}
            />
          ))
        )}
      </div>
    </li>
  );
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

export default BlockListEditor;
