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

/**
 * The menu's items: reorderable, re-parentable, editable, removable.
 *
 * **Ordering is per level, and so is dragging.** `position` is scoped to a parent, so siblings are
 * the only set an order means anything within. Each level is therefore its own sortable context,
 * rendered as a real nested list — dragging a child among its siblings cannot accidentally drop it
 * into another branch, because there is nowhere else for it to land.
 *
 * Moving *between* levels is the "Nested under" select rather than a drag. Free-form tree dragging
 * needs the drop target to encode both position and depth, which in practice means guessing intent
 * from a horizontal offset — fiddly with a mouse and close to unusable with a keyboard. An
 * explicit control says exactly what will happen and is the same interaction for everyone.
 *
 * Move up / Move down buttons are the primary keyboard path, not a fallback. dnd-kit's keyboard
 * sensor works, but nothing announces that space-then-arrows does anything; visible buttons do.
 * Dragging is layered on after hydration so the server-rendered list is complete and usable, and
 * so dnd-kit's generated ids cannot cause a hydration mismatch.
 */

export interface MenuItemNodeData {
  id: string;
  parentId: string | null;
  /** The stored label override, empty when the entry falls back to its target's title. */
  rawLabel: string;
  /** What the entry actually reads as right now — the override, or the target's title. */
  displayLabel: string;
  targetType: 'item' | 'term' | 'url';
  href: string | null;
  brokenReason: 'deleted' | 'unpublished' | 'no_route' | null;
  openInNewTab: boolean;
  noFollow: boolean;
}

export interface MenuItemListProps {
  menuId: string;
  items: MenuItemNodeData[];
}

/**
 * What one row's Save sends.
 *
 * Named rather than written inline at each of the three sites that pass it along — `saveItem`,
 * `LevelProps` and the `RowProps` that extends it. Adding the two `rel` flags to the first two and
 * not the third type-errored, which was the cheap version of this: a patch field that a row can set
 * and the handler quietly drops is the expensive one, and nothing would have caught it.
 *
 * Every key is optional because the route treats absent as "keep what is stored" — see `patchFlag`
 * in `api/menu-items/[itemId].ts` for why that distinction is load-bearing for the two booleans.
 */
export interface MenuItemPatch {
  label?: string;
  parentId?: string | null;
  openInNewTab?: boolean;
  noFollow?: boolean;
}

interface TreeNode extends MenuItemNodeData {
  children: TreeNode[];
}

function buildTree(items: MenuItemNodeData[]): TreeNode[] {
  const nodes = new Map(items.map((item) => [item.id, { ...item, children: [] as TreeNode[] }]));
  const roots: TreeNode[] = [];

  for (const item of items) {
    const node = nodes.get(item.id)!;
    const parent = item.parentId ? nodes.get(item.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  return roots;
}

export default function MenuItemList({ menuId, items: initial }: MenuItemListProps) {
  const [items, setItems] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // False during SSR and the first client render, so both produce identical HTML.
  const [draggable, setDraggable] = useState(false);
  useEffect(() => setDraggable(true), []);

  const tree = buildTree(items);

  async function persistOrder(orderedIds: string[]) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/taproot/menus/${menuId}/reorder`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orderedIds }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setMessage(body?.error ?? `Could not save the new order (${response.status}).`);
      } else {
        setMessage('Order saved.');
      }
    } catch {
      setMessage('Could not reach the server. The new order has not been saved.');
    } finally {
      setBusy(false);
    }
  }

  /** Reorder one sibling group, keeping every other group untouched. */
  function reorderSiblings(parentId: string | null, orderedIds: string[]) {
    setItems((current) => {
      const byId = new Map(current.map((item) => [item.id, item]));
      const reordered = orderedIds.map((id) => byId.get(id)!).filter(Boolean);
      const others = current.filter((item) => (item.parentId ?? null) !== parentId);
      // Order within the array is what the render walks, so the moved group is spliced back whole.
      return [...others, ...reordered];
    });
    void persistOrder(orderedIds);
  }

  async function saveItem(id: string, patch: MenuItemPatch) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/taproot/menu-items/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setMessage(body?.error ?? `Could not save that item (${response.status}).`);
        return;
      }
      /**
       * Reload rather than patching local state.
       *
       * A label change alters what every "Nested under" option reads, and a parent change alters
       * the whole tree and the depth of everything under it. Both are resolved on the server —
       * re-deriving them here would be a second implementation of `resolveMenu` that could drift.
       */
      window.location.href = `/admin/menus/${menuId}?updated=1`;
    } catch {
      setMessage('Could not reach the server. Your change has not been saved.');
    } finally {
      setBusy(false);
    }
  }

  async function removeItem(id: string) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/taproot/menu-items/${id}`, { method: 'DELETE' });
      if (!response.ok) {
        setMessage(`Could not remove that item (${response.status}).`);
        return;
      }
      window.location.href = `/admin/menus/${menuId}?deleted=1`;
    } catch {
      setMessage('Could not reach the server. The item has not been removed.');
    } finally {
      setBusy(false);
    }
  }

  if (items.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-content-muted">
        This menu has no items yet.
      </p>
    );
  }

  const shared = {
    allItems: items,
    draggable,
    busy,
    onReorder: reorderSiblings,
    onSave: saveItem,
    onRemove: removeItem,
  };

  return (
    <div>
      {/* Reordering is a background save with no page change, so its result has to be announced. */}
      <div role="status" aria-live="polite">
        {message && <p className="mb-3 text-sm text-content-muted">{message}</p>}
      </div>

      <Level parentId={null} nodes={tree} {...shared} />
    </div>
  );
}

interface LevelProps {
  parentId: string | null;
  nodes: TreeNode[];
  allItems: MenuItemNodeData[];
  draggable: boolean;
  busy: boolean;
  onReorder: (parentId: string | null, orderedIds: string[]) => void;
  onSave: (id: string, patch: MenuItemPatch) => void;
  onRemove: (id: string) => void;
}

function Level(props: LevelProps) {
  const { parentId, nodes, draggable, onReorder } = props;

  // Declared before the empty-list check: hooks cannot sit behind an early return.
  const sensors = useSensors(
    // A few pixels of slop so clicking into a text field is never read as the start of a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const ids = nodes.map((node) => node.id);

  const labelOf = (id: string | number) =>
    nodes.find((node) => node.id === id)?.displayLabel ?? 'item';
  const indexOf = (id: string | number) => nodes.findIndex((node) => node.id === id);

  // dnd-kit's defaults read out raw ids, which are UUIDs here and useless spoken aloud.
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${labelOf(active.id)}. Use arrow keys to move it.`,
    onDragOver: ({ active, over }) =>
      over ? `${labelOf(active.id)} is now at position ${indexOf(over.id) + 1} of ${nodes.length}.` : '',
    onDragEnd: ({ active, over }) =>
      over
        ? `${labelOf(active.id)} dropped at position ${indexOf(over.id) + 1} of ${nodes.length}.`
        : `${labelOf(active.id)} returned to its original position.`,
    onDragCancel: ({ active }) => `Move cancelled. ${labelOf(active.id)} is back where it started.`,
  };

  function handleDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const from = indexOf(active.id);
    const to = indexOf(over.id);
    if (from === -1 || to === -1) return;

    const next = [...ids];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    onReorder(parentId, next);
  }

  if (nodes.length === 0) return null;

  const list = (
    <ol className="space-y-2">
      {nodes.map((node, index) => (
        <Row {...props} key={node.id} node={node} index={index} total={nodes.length} />
      ))}
    </ol>
  );

  if (!draggable) return list;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis]}
      accessibility={{ announcements }}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {list}
      </SortableContext>
    </DndContext>
  );
}

interface RowProps extends LevelProps {
  node: TreeNode;
  index: number;
  total: number;
}

function Row(props: RowProps) {
  const { node, index, total, parentId, nodes, draggable, busy, allItems, onReorder, onSave, onRemove } =
    props;

  const [label, setLabel] = useState(node.rawLabel);
  const [nextParent, setNextParent] = useState(node.parentId ?? '');
  const [newTab, setNewTab] = useState(node.openInNewTab);
  const [noFollow, setNoFollow] = useState(node.noFollow);

  const sortable = useSortable({ id: node.id, disabled: !draggable });

  const siblingIds = nodes.map((sibling) => sibling.id);
  const moveTo = (offset: number) => {
    const next = [...siblingIds];
    const target = index + offset;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    onReorder(parentId, next);
  };

  /**
   * Candidate parents, minus this item and its own descendants.
   *
   * The server refuses a cycle too, but an option that can only ever produce an error is one that
   * should never have been offered.
   */
  const descendantIds = new Set<string>();
  const collect = (id: string) => {
    descendantIds.add(id);
    for (const child of allItems.filter((item) => item.parentId === id)) collect(child.id);
  };
  collect(node.id);

  const inputClass =
    'mt-1 w-full rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm';

  return (
    <li
      ref={draggable ? sortable.setNodeRef : undefined}
      style={
        draggable
          ? { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }
          : undefined
      }
      className={draggable && sortable.isDragging ? 'opacity-50' : undefined}
    >
      <div className="rounded-lg border border-border bg-surface-raised px-4 py-3">
        <div className="flex flex-wrap items-end gap-3">
          {draggable && (
            <button
              type="button"
              {...sortable.attributes}
              {...sortable.listeners}
              className="cursor-grab rounded px-1 py-2 text-content-subtle hover:text-content"
            >
              <span aria-hidden="true">⠿</span>
              <span className="sr-only-focusable">Reorder {node.displayLabel}</span>
            </button>
          )}

          <div className="min-w-40 flex-1">
            <label htmlFor={`label-${node.id}`} className="block text-xs font-medium">
              Label
              <span className="sr-only-focusable"> for {node.displayLabel}</span>
            </label>
            <input
              id={`label-${node.id}`}
              value={label}
              placeholder={node.displayLabel}
              maxLength={120}
              onChange={(event) => setLabel(event.target.value)}
              className={inputClass}
            />
          </div>

          <div className="min-w-40 flex-1">
            <label htmlFor={`parent-${node.id}`} className="block text-xs font-medium">
              Nested under
              <span className="sr-only-focusable"> for {node.displayLabel}</span>
            </label>
            <select
              id={`parent-${node.id}`}
              value={nextParent}
              onChange={(event) => setNextParent(event.target.value)}
              className={inputClass}
            >
              <option value="">Top level</option>
              {allItems
                .filter((candidate) => !descendantIds.has(candidate.id))
                .map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.displayLabel}
                  </option>
                ))}
            </select>
          </div>

          <div className="flex items-center gap-1">
            {/*
              The primary keyboard path for reordering. Disabled at the ends rather than hidden,
              so the control set does not change shape as an item moves.
            */}
            <button
              type="button"
              disabled={index === 0 || busy}
              onClick={() => moveTo(-1)}
              className="rounded-md border border-border-strong px-2 py-1.5 text-sm transition-colors hover:bg-surface-sunken disabled:opacity-40"
            >
              <span aria-hidden="true">↑</span>
              <span className="sr-only-focusable">Move {node.displayLabel} up</span>
            </button>
            <button
              type="button"
              disabled={index === total - 1 || busy}
              onClick={() => moveTo(1)}
              className="rounded-md border border-border-strong px-2 py-1.5 text-sm transition-colors hover:bg-surface-sunken disabled:opacity-40"
            >
              <span aria-hidden="true">↓</span>
              <span className="sr-only-focusable">Move {node.displayLabel} down</span>
            </button>
          </div>

          <button
            type="button"
            disabled={busy}
            onClick={() =>
              onSave(node.id, {
                label,
                parentId: nextParent === '' ? null : nextParent,
                openInNewTab: newTab,
                noFollow,
              })
            }
            className="rounded-md border border-border-strong px-3 py-1.5 text-sm font-medium transition-colors hover:bg-surface-sunken disabled:opacity-60"
          >
            Save<span className="sr-only-focusable"> {node.displayLabel}</span>
          </button>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
          <span className="rounded-full border border-border px-2 py-0.5 text-content-subtle">
            {node.targetType === 'item' ? 'Page' : node.targetType === 'term' ? 'Term' : 'Address'}
          </span>

          {/*
            Each label names the item in visually hidden text, matching the fields above. Every row
            renders the same two words, so "New tab" alone leaves a screen-reader user with a list of
            identical checkboxes and no way to tell which entry one belongs to.

            These are saved by the row's own Save button rather than on change: a menu row is edited
            as a unit, and a checkbox that persisted immediately would be the one control on the
            screen that did — with no way to undo it and nothing said about it. `flex-wrap` on the
            container is what keeps this off a second axis at 320px.
          */}
          <label htmlFor={`new-tab-${node.id}`} className="flex items-center gap-1.5">
            <input
              id={`new-tab-${node.id}`}
              type="checkbox"
              checked={newTab}
              disabled={busy}
              onChange={(event) => setNewTab(event.target.checked)}
            />
            New tab
            <span className="sr-only-focusable"> for {node.displayLabel}</span>
          </label>

          <label htmlFor={`nofollow-${node.id}`} className="flex items-center gap-1.5">
            <input
              id={`nofollow-${node.id}`}
              type="checkbox"
              checked={noFollow}
              disabled={busy}
              onChange={(event) => setNoFollow(event.target.checked)}
            />
            Nofollow
            <span className="sr-only-focusable"> for {node.displayLabel}</span>
          </label>

          {node.brokenReason === 'deleted' ? (
            <span className="text-warning">Target was deleted — hidden from visitors</span>
          ) : node.brokenReason === 'unpublished' ? (
            <span className="text-content-subtle">
              Target is not published — hidden from visitors
            </span>
          ) : node.brokenReason === 'no_route' ? (
            <span className="text-content-subtle">
              Term link — the address is decided by the site's templates
            </span>
          ) : (
            <code className="break-all font-mono text-content-subtle">{node.href}</code>
          )}

          <button
            type="button"
            disabled={busy}
            onClick={() => onRemove(node.id)}
            className="text-danger transition-colors hover:underline disabled:opacity-60"
          >
            Remove<span className="sr-only-focusable"> {node.displayLabel}</span>
          </button>
        </div>
      </div>

      {node.children.length > 0 && (
        <div className="mt-2 ml-6">
          <Level {...props} parentId={node.id} nodes={node.children} />
        </div>
      )}
    </li>
  );
}
