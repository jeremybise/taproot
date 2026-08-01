import { useEffect, useState } from 'react';
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
import { FIELD_TYPE_META, type FieldRow } from '@taprootcms/core';

/**
 * The field list, reorderable by dragging **and** by buttons.
 *
 * The buttons are not a fallback that could be dropped later — they are the primary keyboard
 * path. The scope doc singles out drag-and-drop reordering as exactly where hand-built admin UI
 * fails WCAG, and dnd-kit's keyboard sensor, while good, is undiscoverable: nothing tells a
 * keyboard user that space-then-arrows does anything. Visible Move up / Move down buttons do.
 *
 * Dragging is layered on **after hydration**. Two reasons, and the second is the load-bearing one:
 *
 *  1. dnd-kit derives `aria-describedby` ids from a module-level counter, so the server and client
 *     render different attributes and React reports a hydration mismatch.
 *  2. It means the list is complete and usable from the server-rendered HTML — reordering works
 *     through the buttons before any JavaScript has run, and dragging is a genuine enhancement
 *     rather than the only way in.
 */

export interface SortableFieldListProps {
  fields: FieldRow[];
  selectedId: string | null;
  onSelect: (field: FieldRow) => void;
  onReorder: (fields: FieldRow[]) => void;
  onRemove: (field: FieldRow) => void;
}

export function SortableFieldList(props: SortableFieldListProps) {
  const { fields } = props;

  // False during SSR and the first client render, so both produce identical HTML.
  const [draggable, setDraggable] = useState(false);
  useEffect(() => setDraggable(true), []);

  if (fields.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-content-muted">
        No fields yet. Add one to get started.
      </p>
    );
  }

  return draggable ? <DraggableList {...props} /> : <StaticList {...props} />;
}

function StaticList({ fields, selectedId, onSelect, onReorder, onRemove }: SortableFieldListProps) {
  return (
    <ol className="space-y-2">
      {fields.map((field, index) => (
        <li key={field.id}>
          <FieldRowContent
            field={field}
            index={index}
            total={fields.length}
            selected={field.id === selectedId}
            onSelect={() => onSelect(field)}
            onMoveUp={() => onReorder(move(fields, index, -1))}
            onMoveDown={() => onReorder(move(fields, index, 1))}
            onRemove={() => onRemove(field)}
          />
        </li>
      ))}
    </ol>
  );
}

function DraggableList({
  fields,
  selectedId,
  onSelect,
  onReorder,
  onRemove,
}: SortableFieldListProps) {
  const sensors = useSensors(
    // A few pixels of slop so clicking a field to select it is not read as a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const labelOf = (id: string | number) =>
    fields.find((field) => field.id === id)?.label ?? 'field';
  const indexOf = (id: string | number) => fields.findIndex((field) => field.id === id);

  // dnd-kit's defaults announce raw ids, which are UUIDs here and useless read aloud.
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${labelOf(active.id)}. Use arrow keys to move it.`,
    onDragOver: ({ active, over }) =>
      over
        ? `${labelOf(active.id)} is now at position ${indexOf(over.id) + 1} of ${fields.length}.`
        : '',
    onDragEnd: ({ active, over }) =>
      over
        ? `${labelOf(active.id)} dropped at position ${indexOf(over.id) + 1} of ${fields.length}.`
        : `${labelOf(active.id)} returned to its original position.`,
    onDragCancel: ({ active }) => `Move cancelled. ${labelOf(active.id)} is back where it started.`,
  };

  function handleDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;

    const from = indexOf(active.id);
    const to = indexOf(over.id);
    if (from === -1 || to === -1) return;

    const next = [...fields];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    onReorder(next);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis]}
      accessibility={{ announcements }}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={fields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
        <ol className="space-y-2">
          {fields.map((field, index) => (
            <SortableRow
              key={field.id}
              field={field}
              index={index}
              total={fields.length}
              selected={field.id === selectedId}
              onSelect={() => onSelect(field)}
              onMoveUp={() => onReorder(move(fields, index, -1))}
              onMoveDown={() => onReorder(move(fields, index, 1))}
              onRemove={() => onRemove(field)}
            />
          ))}
        </ol>
      </SortableContext>
    </DndContext>
  );
}

interface RowProps {
  field: FieldRow;
  index: number;
  total: number;
  selected: boolean;
  onSelect: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}

function SortableRow(props: RowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.field.id,
  });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? 'opacity-50' : undefined}
    >
      <FieldRowContent
        {...props}
        dragHandle={
          // A real button, so it is focusable and announced. dnd-kit's `attributes` add the
          // keyboard-drag instructions it renders elsewhere in the DOM.
          <button
            type="button"
            {...attributes}
            {...listeners}
            className="cursor-grab rounded px-1 py-1 text-content-subtle hover:text-content"
          >
            <span aria-hidden="true">⠿</span>
            <span className="sr-only-focusable">Reorder {props.field.label}</span>
          </button>
        }
      />
    </li>
  );
}

function FieldRowContent({
  field,
  index,
  total,
  selected,
  onSelect,
  onMoveUp,
  onMoveDown,
  onRemove,
  dragHandle,
}: RowProps & { dragHandle?: React.ReactNode }) {
  const meta = FIELD_TYPE_META[field.type];

  return (
    <div
      className={`flex items-center gap-2 rounded-lg border bg-surface-raised px-3 py-2.5 ${
        selected ? 'border-accent' : 'border-border'
      }`}
    >
      {dragHandle}

      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className="min-w-0 flex-1 text-left"
      >
        <span className="flex flex-wrap items-baseline gap-2">
          <span className="font-medium">{field.label}</span>
          <code className="font-mono text-xs text-content-subtle">{field.api_id}</code>
          {field.required === 1 && (
            <span className="rounded-full border border-border px-2 py-0.5 text-xs">Required</span>
          )}
        </span>
        <span className="mt-0.5 block text-sm text-content-muted">
          {meta.label}
          <span className="sr-only-focusable">
            , position {index + 1} of {total}
          </span>
        </span>
      </button>

      <div className="flex gap-1">
        <button
          type="button"
          onClick={onMoveUp}
          disabled={index === 0}
          className="rounded-md border border-border-strong px-2.5 py-1.5 text-sm disabled:opacity-40"
        >
          <span aria-hidden="true">↑</span>
          <span className="sr-only-focusable">
            Move {field.label} up, currently {index + 1} of {total}
          </span>
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          disabled={index === total - 1}
          className="rounded-md border border-border-strong px-2.5 py-1.5 text-sm disabled:opacity-40"
        >
          <span aria-hidden="true">↓</span>
          <span className="sr-only-focusable">
            Move {field.label} down, currently {index + 1} of {total}
          </span>
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="rounded-md border border-border-strong px-2.5 py-1.5 text-sm text-danger hover:bg-danger-subtle"
        >
          <span aria-hidden="true">✕</span>
          <span className="sr-only-focusable">Remove the {field.label} field</span>
        </button>
      </div>
    </div>
  );
}

/** Move an item within a list, returning a new array. */
function move<T>(items: T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  if (target < 0 || target >= items.length) return items;

  const next = [...items];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved!);
  return next;
}

export default SortableFieldList;
