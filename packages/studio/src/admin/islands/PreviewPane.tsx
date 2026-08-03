import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { PREVIEW_MESSAGE, type SeoData } from '@taprootcms/core';

/**
 * The site, rendered beside the editor, following what is being typed.
 *
 * **Taproot ships no templates**, so there is nothing here to render a page *with* — and that is
 * the whole shape of this component. The rendering lives on the consumer, which resolves the page
 * server-side, so what crosses the gap is not markup but the editor's unsaved form state: it is
 * parked on the preview token by `writePreviewDraft`, and the site's own SSR route picks it up on
 * its next fetch. A second renderer inside the CMS would be exactly the drift `resolveSeo` living
 * in core exists to prevent.
 *
 * Everything below is therefore about three things: getting a token, keeping the snapshot current,
 * and asking the frame to reload without breaking the editor around it.
 */

interface Props {
  itemId: string;
  releaseId?: string | null;
  /** Live editor state. The same objects that will be saved. */
  title: string;
  slug: string;
  data: Record<string, unknown>;
  seo: SeoData;
  /** Where the item resolves publicly. Used as the address the frame starts on. */
  itemPath: string;
  /** False when `TAPROOT_SITE_URL` is unset, which the pane explains rather than failing at. */
  siteConfigured: boolean;
  /**
   * Whether the pane is showing.
   *
   * Owned by the eye icon in the editor's sticky bar and mirrored here from `data-preview` on
   * `<html>` — the
   * same attribute the layout stamps server-side and the same one the width rule reads. The button
   * lives in the page header, outside this island, and there is deliberately no second copy of this
   * state for the two to disagree about.
   */
  open: boolean;
}

/**
 * Long enough that a pause in typing is a real pause, short enough to feel live.
 *
 * Debounced because it is a network call — the repo's rule is to debounce the network and never the
 * pure recomputation, which is why `AccessibilityPanel` next door has no timer at all.
 */
const QUIET_MS = 600;

const WIDTHS = [
  { id: 'phone', label: 'Phone', className: 'max-w-[390px]' },
  { id: 'tablet', label: 'Tablet', className: 'max-w-[768px]' },
  { id: 'full', label: 'Full', className: 'max-w-full' },
] as const;

type WidthId = (typeof WIDTHS)[number]['id'];

interface Session {
  token: string;
  siteUrl: string;
}

export default function PreviewPane({
  itemId,
  releaseId = null,
  title,
  slug,
  data,
  seo,
  itemPath,
  siteConfigured,
  open,
}: Props) {
  const paneId = useId();
  const [session, setSession] = useState<Session | null>(null);
  const [address, setAddress] = useState(itemPath || '/');
  const [addressDraft, setAddressDraft] = useState(itemPath || '/');
  const [width, setWidth] = useState<WidthId>('full');
  /**
   * Bumped to remount the iframe.
   *
   * Assigning `.src` on a loaded iframe **pushes a session history entry**, so the admin's Back
   * button starts walking backwards through preview reloads instead of leaving the editor.
   * `location.replace` is not reachable across origins. A fresh element's first navigation is a
   * replace, so changing the React key is the only version of this with a working Back button.
   */
  const [frameKey, setFrameKey] = useState(0);
  const [busy, setBusy] = useState(false);
  /** Only the exceptional cases. See the `role="status"` note below. */
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * Whether the consumer is running `<TaprootPreviewBridge />`.
   *
   * A ref rather than state: it changes at most once per frame load, nothing renders differently
   * because of it, and putting it in state would re-render the pane on a handshake.
   */
  const bridged = useRef(false);
  /** One request in flight at a time — see `flush`. */
  const inFlight = useRef(false);
  const pending = useRef(false);

  const snapshot = useRef({ title, slug, data, seo });
  snapshot.current = { title, slug, data, seo };

  const refreshFrame = useCallback((siteUrl: string) => {
    /**
     * Reload from inside the frame where we can, and remount where we cannot.
     *
     * The difference is scroll position: a reload the page performs on itself keeps it, and a
     * navigation the parent performs does not. On a long page that is the difference between a
     * preview somebody uses while writing and one they close.
     */
    if (bridged.current) {
      const frame = document.getElementById(`${paneId}-frame`) as HTMLIFrameElement | null;
      frame?.contentWindow?.postMessage({ type: PREVIEW_MESSAGE.refresh }, siteUrl);
      return;
    }
    setFrameKey((key) => key + 1);
  }, [paneId]);

  /**
   * Send the current snapshot, then refresh — in that order, and never two at once.
   *
   * Refreshing on the same timer as the write is the bug that makes a live preview feel broken: the
   * frame reloads, fetches the snapshot that was current a moment ago, and every edit shows up one
   * beat late. Two concurrent writes can also land out of order and leave the older one winning, so
   * a change arriving mid-flight sets `pending` and is picked up on the way out.
   */
  const flush = useCallback(async () => {
    if (!session || inFlight.current) {
      if (session) pending.current = true;
      return;
    }

    inFlight.current = true;
    setBusy(true);

    try {
      const response = await fetch('/api/taproot/preview', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: session.token, ...snapshot.current }),
      });

      if (response.status === 404) {
        /**
         * The token is gone — swept, or the tab slept past its expiry.
         *
         * Re-mint carrying the current draft in the same request, so the new frame opens on what is
         * being edited rather than on the saved page. Writing slides the expiry, so this is rare
         * rather than a thirty-minute clock.
         */
        const minted = await mint(itemId, releaseId, snapshot.current);
        if (minted) {
          setSession(minted);
          setNotice('The preview link expired and has been renewed.');
          setFrameKey((key) => key + 1);
        } else {
          setNotice('The preview is no longer available. Reload the page to start a new one.');
        }
        return;
      }

      if (response.ok) {
        const payload = (await response.json().catch(() => null)) as { stale?: boolean } | null;
        // `stale` is not a failure: the previous snapshot is still in the row and still renders.
        setNotice(
          payload?.stale
            ? 'Showing your last valid draft — a field is longer than this content type allows.'
            : null,
        );
        refreshFrame(session.siteUrl);
      }
    } catch {
      // A network blip is not worth a message. The next keystroke tries again, and the frame is
      // still showing the last good state in the meantime.
    } finally {
      inFlight.current = false;
      setBusy(false);
      if (pending.current) {
        pending.current = false;
        void flush();
      }
    }
  }, [session, itemId, releaseId, refreshFrame]);

  // Mint on open, not on mount: nothing is created until somebody asks to see it, and no token is
  // ever in the HTML this admin serves.
  useEffect(() => {
    if (!open || session || !siteConfigured) return;

    let cancelled = false;
    void mint(itemId, releaseId, snapshot.current).then((minted) => {
      if (cancelled) return;
      if (minted) setSession(minted);
      else setNotice('Could not start a preview. Check that the site URL is reachable.');
    });

    return () => {
      cancelled = true;
    };
  }, [open, session, siteConfigured, itemId, releaseId]);

  // The debounce itself. Deliberately keyed on the editor's live values, so it is the same signal
  // `AccessibilityPanel` recomputes from — one source of "what the form currently holds".
  useEffect(() => {
    if (!open || !session) return;
    const timer = setTimeout(() => void flush(), QUIET_MS);
    return () => clearTimeout(timer);
  }, [open, session, title, slug, data, seo, flush]);

  // The handshake. `event.origin` is checked rather than trusted, and the reply lives on the
  // consumer's side — this end only listens.
  useEffect(() => {
    if (!session) return;

    function onMessage(event: MessageEvent) {
      if (event.origin !== session!.siteUrl) return;
      if ((event.data as { type?: string } | null)?.type === PREVIEW_MESSAGE.ready) {
        bridged.current = true;
      }
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [session]);

  const frameSrc = session
    ? `${session.siteUrl}${address}${address.includes('?') ? '&' : '?'}taproot_preview=${session.token}`
    : null;

  return (
    /*
      `id` is fixed rather than generated, because the toggle that controls this lives outside the
      island — `EditorActionIcons` points `aria-controls` at it, and a `useId` value is not
      knowable from an Astro component. Rendered whether open or closed, so that reference always
      resolves: a dangling `aria-controls` is an axe violation and a broken promise to a screen
      reader.
    */
    /*
      Sticky at `xl`, where the split view exists.
      
      `top-6` rather than `top-0`: the Save strip in the neighbouring column is `sticky top-0 z-10`
      with its own stacking context from `backdrop-blur`, and two sticky bars pinning at the same
      offset with only a gap between them read as one broken element. A lower `z` for the same
      reason — if they ever do overlap, the one with the Save button wins.

      This works because no ancestor of `#main` sets `overflow` or a height, and because the grid
      carries `xl:items-start`; a sticky grid child under the default `stretch` fills the row and
      has nowhere to travel.
    */
    <section
      id="editor-preview-pane"
      aria-labelledby={`${paneId}-heading`}
      className="min-w-0 xl:sticky xl:top-6 xl:z-0"
    >
      {/*
        Named for the accessibility tree but not drawn: the icon that opens this already carries the
        words "Live preview", and a heading repeating them would be the second thing on screen
        saying so. The section still needs a name, or it is an unlabelled region.
      */}
      <h2 id={`${paneId}-heading`} className="sr-only">
        Live preview
      </h2>

      <div>
        {!open ? null : !siteConfigured ? (
          <p className="rounded-lg border border-border bg-surface-raised p-4 text-sm text-content-muted">
            Taproot does not know where your site is, so it cannot show a preview. Set{' '}
            <code>TAPROOT_SITE_URL</code> to the origin of the site that reads this content.
          </p>
        ) : (
          /*
            A definite viewport height at `xl`, and a flex column so the frame absorbs what is left.

            `h-`, not `max-h-`. A max bounds the card without giving it a height, so it still sized
            to its content — and `flex-1` on the frame had no leftover space to claim, leaving a
            short pane pinned in a tall empty column. A definite height is what gives `flex-1`
            something to divide.

            Unbounded, the card is roughly 90dvh of frame plus toolbar, status row and footer — so
            pinning it would put the footer permanently below the fold with no way to scroll to it,
            because a sticky element does not scroll independently of the page.

            `dvh`, not `vh`: on a phone `100vh` is taller than the visible viewport, which is the
            same reason the sidebar uses `h-dvh`.
          */
          <div className="flex flex-col rounded-lg border border-border bg-surface-raised xl:h-[calc(100dvh-3rem)]">
            <Toolbar
              paneId={paneId}
              addressDraft={addressDraft}
              onAddressDraft={setAddressDraft}
              onAddressSubmit={() => {
                setAddress(addressDraft.startsWith('/') ? addressDraft : `/${addressDraft}`);
                setFrameKey((key) => key + 1);
              }}
              width={width}
              onWidth={setWidth}
              busy={busy}
              openHref={frameSrc}
              onRefresh={() => void flush()}
            />

            {/*
              Polite and exceptional only.

              The accessibility panel next door announces on every keystroke because *its text* is
              the information. Here the information is inside a cross-origin frame a screen-reader
              user has to enter to read at all, so announcing "preview updated" every debounce tick
              is interruption with nothing behind it. What goes here instead is the handful of
              things somebody genuinely needs told.
            */}
            <div role="status" aria-live="polite" className="px-3">
              {notice && <p className="pb-2 text-xs text-danger">{notice}</p>}
            </div>

            {/* `min-h-0` or the flex child refuses to shrink below its content and the bound above
                does nothing. The classic flexbox footgun. */}
            <div className="flex min-h-0 flex-1 flex-col border-t border-border bg-surface-sunken p-3">
              <div
                className={`mx-auto flex min-h-0 w-full flex-1 flex-col ${WIDTHS.find((w) => w.id === width)!.className}`}
              >
                {frameSrc ? (
                  <iframe
                    // Remounted rather than re-`src`-ed. See `frameKey`.
                    key={frameKey}
                    id={`${paneId}-frame`}
                    src={frameSrc}
                    /*
                      A stable name. Interpolating the live title would give this a changing
                      accessible name on every keystroke, which is announced churn carrying no
                      information a screen-reader user cannot get by entering the frame.
                    */
                    title="Live preview of this content item"
                    /*
                      `allow-top-navigation` is omitted deliberately: without it the previewed page
                      cannot navigate the admin away, and the previewed page is the site's own
                      markup, where a stray `target="_top"` would otherwise throw an editor out of a
                      form full of unsaved work.

                      `allow-scripts` with `allow-same-origin` is safe here precisely because the
                      site is a *different* origin from the CMS — the frame gets its own origin's
                      storage and none of the admin's.
                    */
                    sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
                    referrerPolicy="no-referrer"
                    onLoad={() => {
                      const frame = document.getElementById(
                        `${paneId}-frame`,
                      ) as HTMLIFrameElement | null;
                      frame?.contentWindow?.postMessage(
                        { type: PREVIEW_MESSAGE.hello },
                        session!.siteUrl,
                      );
                    }}
                    className="h-[70dvh] w-full rounded-md border border-border bg-surface xl:h-auto xl:min-h-0 xl:flex-1"
                  />
                ) : (
                  <p className="py-8 text-center text-sm text-content-muted">Starting preview…</p>
                )}
              </div>
            </div>

            {/*
              Said once, quietly, because the alternative is every editor previewing a new page
              concluding the navigation is broken. Menus and listings come from delivery endpoints
              that have no preview path at all.
            */}
            <p className="border-t border-border px-3 py-2 text-xs text-content-subtle">
              Navigation and listings show published content only.
            </p>
          </div>
        )}
      </div>

      <LoadHint active={open && Boolean(frameSrc)} siteUrl={session?.siteUrl} probeKey={frameKey} />
    </section>
  );
}

function Toolbar({
  paneId,
  addressDraft,
  onAddressDraft,
  onAddressSubmit,
  width,
  onWidth,
  busy,
  openHref,
  onRefresh,
}: {
  paneId: string;
  addressDraft: string;
  onAddressDraft: (value: string) => void;
  onAddressSubmit: () => void;
  width: WidthId;
  onWidth: (id: WidthId) => void;
  busy: boolean;
  openHref: string | null;
  onRefresh: () => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3 p-3">
      <div className="min-w-0 flex-1">
        {/*
          A real `<label for>`: an `<input>` is a labelable element, unlike the button lists
          elsewhere in this editor, which are named through `aria-labelledby` because a label
          pointing at a `<ul>` is silently inert.
        */}
        <label htmlFor={`${paneId}-address`} className="block text-xs font-medium">
          Preview address
        </label>
        <div className="mt-1 flex gap-2">
          <input
            id={`${paneId}-address`}
            value={addressDraft}
            onChange={(event) => onAddressDraft(event.target.value)}
            onKeyDown={(event) => {
              // Not a nested `<form>`: this island already renders inside the editor's form, and a
              // form inside a form is invalid HTML that browsers resolve by dropping one of them.
              if (event.key === 'Enter') {
                event.preventDefault();
                onAddressSubmit();
              }
            }}
            aria-describedby={`${paneId}-address-hint`}
            className="min-w-0 flex-1 rounded-md border border-border-strong bg-surface px-2 py-1 font-mono text-xs"
          />
          <button
            type="button"
            onClick={onAddressSubmit}
            className="rounded-md border border-border-strong px-2 py-1 text-xs font-medium transition-colors hover:bg-surface-sunken"
          >
            Go
          </button>
        </div>
        <p id={`${paneId}-address-hint`} className="mt-1 text-xs text-content-subtle">
          Unsaved changes appear on this item’s own page. Other addresses show the live site.
        </p>
      </div>

      <div>
        {/*
          A span, not a `<label for>`: what follows is a list of buttons, and a label pointing at a
          `<ul>` is silently inert — `scripts/a11y-audit.mjs` checks exactly that.
        */}
        <span id={`${paneId}-width-label`} className="block text-xs font-medium">
          Width
        </span>
        {/*
          Preset buttons rather than a drag splitter. A pixel-perfect drag has no editorial value,
          and "does this work on a phone" is the question editors actually ask. If a drag handle is
          ever added it goes *alongside* these and needs the full separator contract —
          `role="separator"`, `aria-valuenow`, Arrow keys and Home/End — never instead of them.
        */}
        <ul aria-labelledby={`${paneId}-width-label`} className="mt-1 flex gap-1">
          {WIDTHS.map((option) => (
            <li key={option.id}>
              <button
                type="button"
                aria-pressed={width === option.id}
                onClick={() => onWidth(option.id)}
                className={`rounded-md border px-2 py-1 text-xs font-medium transition-colors ${
                  width === option.id
                    ? 'border-accent bg-accent-subtle'
                    : 'border-border-strong hover:bg-surface-sunken'
                }`}
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onRefresh}
          className="rounded-md border border-border-strong px-2 py-1 text-xs font-medium transition-colors hover:bg-surface-sunken"
        >
          Refresh
        </button>
        {openHref && (
          <a
            href={openHref}
            target="_blank"
            rel="noopener"
            className="rounded-md px-2 py-1 text-xs text-content-muted underline transition-colors hover:bg-surface-sunken"
          >
            Open in a new tab
            <span className="sr-only-focusable"> (opens in a new tab)</span>
          </a>
        )}
        {/*
          Visual only, and `aria-hidden` on purpose: it says the same thing the live region would
          say on every debounce tick, which is why it is not in the live region.
        */}
        <span
          aria-hidden="true"
          className={`h-2 w-2 rounded-full transition-opacity ${
            busy ? 'bg-accent opacity-100' : 'opacity-0'
          }`}
        />
      </div>
    </div>
  );
}

/**
 * A hint when the site cannot be reached.
 *
 * **Not a timer, and not `onLoad`.** Two earlier versions of this were each wrong in the opposite
 * direction. A pure eight-second timer accused a perfectly healthy site every single time, because
 * it never learned the frame had loaded. Wiring it to the iframe's `onLoad` then killed it
 * altogether: Chrome fires `load` for a connection-refused error page too, so "loaded" was always
 * true and a genuinely dead site said nothing.
 *
 * A `no-cors` request is the signal neither of those had. The response is opaque — nothing about it
 * can be read, which is fine, because the only question is whether anything answered at all. A
 * server that responded resolves; a refused connection rejects. That distinguishes exactly the case
 * worth reporting, immediately, with no guessing interval.
 *
 * Silent when the probe cannot run for some other reason. A hint that is unsure is worse than none:
 * this one exists to explain a blank frame, and accusing somebody's working dev server of being
 * down is precisely the failure it is meant to prevent.
 */
function LoadHint({
  active,
  siteUrl,
  probeKey,
}: {
  active: boolean;
  siteUrl?: string;
  /** Changes whenever the frame is remounted, so a retry re-probes rather than trusting a stale result. */
  probeKey: number;
}) {
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    if (!active || !siteUrl) {
      setUnreachable(false);
      return;
    }

    let cancelled = false;
    setUnreachable(false);

    fetch(siteUrl, { mode: 'no-cors', cache: 'no-store' })
      .then(() => {
        // Opaque, and that is all it needs to be: something answered.
        if (!cancelled) setUnreachable(false);
      })
      .catch(() => {
        if (!cancelled) setUnreachable(true);
      });

    return () => {
      cancelled = true;
    };
  }, [active, siteUrl, probeKey]);

  if (!active || !unreachable || !siteUrl) return null;

  return (
    <p role="status" className="mt-2 text-xs text-danger">
      Could not reach {siteUrl}. Is your site running?
    </p>
  );
}

async function mint(
  itemId: string,
  releaseId: string | null,
  draft: { title: string; slug: string; data: Record<string, unknown>; seo: SeoData },
): Promise<Session | null> {
  try {
    const response = await fetch('/api/taproot/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The draft rides along, so the first frame shows what is being edited rather than the saved
      // page followed a beat later by a reload.
      body: JSON.stringify({ item: itemId, release: releaseId, draft }),
    });
    if (!response.ok) return null;

    const payload = (await response.json()) as { token: string; siteUrl: string };
    return { token: payload.token, siteUrl: new URL(payload.siteUrl).origin };
  } catch {
    return null;
  }
}
