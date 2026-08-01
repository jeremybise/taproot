import { useId, useRef, useState } from 'react';
import {
  NO_CROP,
  PREVIEW_ASPECTS,
  cropBackground,
  cropRect,
  resolveCrop,
  type Crop,
  type Hotspot,
} from '@taproot/core';

/**
 * The hotspot and crop editor.
 *
 * Two decisions, kept separate because editors make them separately: *what part of this image
 * matters* (the hotspot) and *what part is worth showing at all* (the crop). Neither is a baked
 * crop — the stored values are normalised, so one asset drives every shape the site uses.
 *
 * **Why several previews at once.** An editor choosing a focal point is making one decision that
 * plays out in every shape the image will ever appear in, and they cannot judge it from a single
 * frame. Showing the wide, square, and portrait crops side by side as the point moves is the whole
 * feature; a single preview would look finished and be useless.
 *
 * **Keyboard is the primary path, not the fallback.** The focal point is a slider in two
 * dimensions: arrow keys move it a percent at a time, Shift a tenth, Home/End and PageUp/PageDown
 * jump to the edges. Dragging is layered on top for pointer users. The crop is four native range
 * inputs, which are keyboard-operable for free and announce their values without any ARIA.
 */

export interface HotspotEditorProps {
  mediaId: string;
  url: string;
  altText: string | null;
  /** Null when the format's dimensions could not be read; previews degrade rather than lie. */
  width: number | null;
  height: number | null;
  initialHotspot: Hotspot;
  initialCrop: Crop;
  canEdit: boolean;
}

const STEP = 0.01;
const BIG_STEP = 0.1;

export default function HotspotEditor({
  mediaId,
  url,
  altText,
  width,
  height,
  initialHotspot,
  initialCrop,
  canEdit,
}: HotspotEditorProps) {
  const [hotspot, setHotspot] = useState<Hotspot>(initialHotspot);
  const [crop, setCrop] = useState<Crop>(initialCrop);
  const [saved, setSaved] = useState<{ hotspot: Hotspot; crop: Crop }>({
    hotspot: initialHotspot,
    crop: initialCrop,
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const dimensions = { width, height };

  const dirty =
    hotspot.x !== saved.hotspot.x ||
    hotspot.y !== saved.hotspot.y ||
    (['top', 'right', 'bottom', 'left'] as const).some((side) => crop[side] !== saved.crop[side]);

  const region = cropRect(crop);

  /**
   * Move the focal point, clamped into the crop.
   *
   * A hotspot outside the crop is not meaningful — it points at something the editor has already
   * said is not in the picture — and every preview would then pin to the same edge, which looks
   * like the control has stopped responding.
   */
  function moveHotspot(next: Partial<Hotspot>) {
    setHotspot((current) => {
      const merged = { ...current, ...next };
      return {
        x: clamp(merged.x, region.x, region.x + region.width),
        y: clamp(merged.y, region.y, region.y + region.height),
      };
    });
  }

  function onStageKeyDown(event: React.KeyboardEvent) {
    if (!canEdit) return;
    const step = event.shiftKey ? BIG_STEP : STEP;

    const moves: Record<string, Partial<Hotspot>> = {
      ArrowLeft: { x: hotspot.x - step },
      ArrowRight: { x: hotspot.x + step },
      ArrowUp: { y: hotspot.y - step },
      ArrowDown: { y: hotspot.y + step },
      Home: { x: region.x },
      End: { x: region.x + region.width },
      PageUp: { y: region.y },
      PageDown: { y: region.y + region.height },
    };

    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    moveHotspot(move);
  }

  function pointTo(clientX: number, clientY: number) {
    const box = stageRef.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return;
    moveHotspot({ x: (clientX - box.left) / box.width, y: (clientY - box.top) / box.height });
  }

  function onPointerDown(event: React.PointerEvent) {
    if (!canEdit) return;
    // Capture on the stage so a fast drag that leaves the image keeps tracking, and so the
    // pointerup arrives here rather than wherever the cursor happened to end up.
    event.currentTarget.setPointerCapture(event.pointerId);
    pointTo(event.clientX, event.clientY);
  }

  function onPointerMove(event: React.PointerEvent) {
    if (!canEdit || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    pointTo(event.clientX, event.clientY);
  }

  function setSide(side: keyof Crop, value: number) {
    setCrop((current) => {
      const next = { ...current, [side]: value };
      // Opposite insets must leave something behind; everything downstream divides by the region.
      const horizontal = next.left + next.right;
      const vertical = next.top + next.bottom;
      if (horizontal >= 0.9 || vertical >= 0.9) return current;
      return next;
    });
  }

  async function save() {
    setBusy(true);
    setMessage(null);

    try {
      const response = await fetch(`/api/taproot/media/${mediaId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          hotspot_x: hotspot.x,
          hotspot_y: hotspot.y,
          crop_top: crop.top,
          crop_right: crop.right,
          crop_bottom: crop.bottom,
          crop_left: crop.left,
        }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setFailed(true);
        setMessage(body?.error ?? `Save failed (${response.status}).`);
        return;
      }

      setSaved({ hotspot, crop });
      setFailed(false);
      setMessage('Focal point and crop saved.');
    } catch {
      setFailed(true);
      setMessage('Could not reach the server. Your changes have not been saved.');
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setHotspot({ x: 0.5, y: 0.5 });
    setCrop(NO_CROP);
  }

  const percent = (value: number) => `${Math.round(value * 100)}%`;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <div>
        <h2 id={`${id}-stage-heading`} className="text-base font-semibold">
          Focal point
        </h2>
        <p id={`${id}-stage-hint`} className="mt-1 max-w-prose text-sm text-content-muted">
          The part of the image that must stay visible in every crop. Drag it, or focus the image
          and use the arrow keys — hold Shift to move faster.
        </p>

        {/*
          `role="application"` is deliberately NOT used. It would suppress the screen reader's
          browse mode wholesale; a focusable group with a described keyboard contract keeps normal
          reading working and still receives the arrow keys.
        */}
        <div
          ref={stageRef}
          role="group"
          tabIndex={canEdit ? 0 : -1}
          aria-labelledby={`${id}-stage-heading`}
          aria-describedby={`${id}-stage-hint ${id}-position`}
          onKeyDown={onStageKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          className={`relative mt-3 inline-block max-w-full overflow-hidden rounded-lg border border-border ${
            canEdit ? 'cursor-crosshair touch-none' : ''
          }`}
        >
          <img src={url} alt={altText ?? ''} className="block max-h-[28rem] w-auto max-w-full" />

          {/* The cropped-away area, dimmed rather than hidden so the editor keeps their bearings. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-surface-sunken/70"
            style={{
              clipPath: `polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%, ${percent(
                region.x,
              )} ${percent(region.y)}, ${percent(region.x)} ${percent(
                region.y + region.height,
              )}, ${percent(region.x + region.width)} ${percent(
                region.y + region.height,
              )}, ${percent(region.x + region.width)} ${percent(region.y)}, ${percent(
                region.x,
              )} ${percent(region.y)})`,
            }}
          />

          <div
            aria-hidden="true"
            className="pointer-events-none absolute border-2 border-accent"
            style={{
              left: percent(region.x),
              top: percent(region.y),
              width: percent(region.width),
              height: percent(region.height),
            }}
          />

          <div
            aria-hidden="true"
            className="pointer-events-none absolute size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent-content bg-accent shadow"
            style={{ left: percent(hotspot.x), top: percent(hotspot.y) }}
          />
        </div>

        {/*
          The live region is the whole reason the keyboard path works: without it, arrow presses
          change a purely visual marker and a screen reader user gets no feedback at all.
        */}
        <p
          id={`${id}-position`}
          data-testid="hotspot-position"
          aria-live="polite"
          className="mt-2 text-sm text-content-muted"
        >
          Focal point {percent(hotspot.x)} from the left, {percent(hotspot.y)} from the top.
        </p>

        <h2 className="mt-6 text-base font-semibold">Crop</h2>
        <p className="mt-1 max-w-prose text-sm text-content-muted">
          Trim edges out of every use of this image. The original file is never modified.
        </p>

        <div className="mt-3 grid max-w-md gap-3 sm:grid-cols-2">
          {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
            <div key={side}>
              {/*
                The visible text is the accessible name, spelled out rather than produced by CSS
                `capitalize` — which changes only the rendering, leaving a screen reader to
                announce "top". "From top" also survives being read out of context in a list of
                form fields, where a bare "Top" means nothing.
              */}
              <label htmlFor={`${id}-${side}`} className="block text-sm font-medium">
                From {side}
              </label>
              {/*
                A native range input: keyboard-operable, announced with its value and units, and
                draggable — all without a line of ARIA. A custom handle would have to re-implement
                every one of those.
              */}
              <input
                id={`${id}-${side}`}
                type="range"
                min={0}
                max={0.9}
                step={0.01}
                disabled={!canEdit}
                value={crop[side]}
                aria-valuetext={percent(crop[side])}
                onChange={(e) => setSide(side, Number(e.target.value))}
                className="mt-1 w-full"
              />
              <span className="text-xs text-content-subtle">{percent(crop[side])}</span>
            </div>
          ))}
        </div>

        {canEdit && (
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={busy || !dirty}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-content transition-colors hover:bg-accent-hover disabled:opacity-60"
            >
              {busy ? 'Saving…' : 'Save focal point and crop'}
            </button>
            <button
              type="button"
              onClick={reset}
              className="rounded-md border border-border-strong px-4 py-2 text-sm font-medium transition-colors hover:bg-surface-sunken"
            >
              Reset to centre
            </button>
            {dirty && <span className="text-sm text-content-subtle">Unsaved changes</span>}
          </div>
        )}

        <div role="status" aria-live="polite" className="mt-3">
          {message && (
            <p
              className={`rounded-md border px-4 py-2.5 text-sm ${
                failed ? 'border-danger bg-danger-subtle' : 'border-accent bg-accent-subtle'
              }`}
            >
              {message}
            </p>
          )}
        </div>
      </div>

      <aside aria-labelledby={`${id}-previews-heading`}>
        <h2 id={`${id}-previews-heading`} className="text-base font-semibold">
          In every shape
        </h2>
        <p className="mt-1 text-sm text-content-muted">
          {width && height
            ? 'Updates as you move the focal point.'
            : 'Approximate — the dimensions of this file could not be read, so the crop is shown as-is.'}
        </p>

        <ul className="mt-3 space-y-4">
          {PREVIEW_ASPECTS.map((aspect) => {
            const rect = resolveCrop(dimensions, aspect.ratio, hotspot, crop);
            return (
              <li key={aspect.label}>
                {/*
                  A background rather than an <img>: `object-position` can only slide the whole
                  image, so it cannot express a crop — the trimmed edges would still be visible.
                  Decorative either way, since the same image is already described once on the
                  stage and four more copies of its alt text would be noise.
                */}
                <div
                  role="img"
                  aria-label={`${aspect.label} preview`}
                  className="rounded-md border border-border bg-surface-sunken bg-no-repeat"
                  style={{
                    aspectRatio: String(aspect.ratio),
                    backgroundImage: `url("${url}")`,
                    ...cropBackground(rect),
                  }}
                />
                <p className="mt-1 text-xs">
                  <span className="font-medium">{aspect.label}</span>
                  <span className="text-content-subtle"> · {aspect.hint}</span>
                </p>
              </li>
            );
          })}
        </ul>
      </aside>
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
