import { useId } from 'react';
import { AlertTriangle, ExternalLink } from 'lucide-react';

import { embedHostAllowed, type EmbedValue } from '@taprootcms/core';

/**
 * The editor for an `embed` field: an address and the frame's title.
 *
 * **There is no frame in here, and that is deliberate.** Rendering the embed at the point of editing
 * would put a third-party origin inside the admin — the one origin holding the session — to answer a
 * question the preview pane already answers against the real page, with the real width and the real
 * surrounding content. Same rule as "there is one preview control, not two": the pane is it, and
 * this offers a link out instead.
 *
 * The host check below is **feedback, not enforcement**. `validateItemData` is the boundary, for the
 * reason it is for richtext — the REST API takes this value from any client holding a session, so a
 * control that refused a host would be a suggestion. What this buys is that an editor learns the
 * address is wrong while looking at it, rather than in an error summary after pressing Save. It
 * calls the same `embedHostAllowed` the server does so the two cannot disagree about what
 * `youtube.com` covers.
 */

interface Props {
  id?: string;
  labelledBy?: string;
  describedBy?: string;
  value: EmbedValue | null;
  onChange: (value: EmbedValue | null) => void;
  /** Domains this field may frame. Empty admits nothing — see `embedValueSchema` in core. */
  allowedHosts: string[];
  disabled?: boolean;
  invalid?: boolean;
}

export function EmbedField({
  id,
  labelledBy,
  describedBy,
  value,
  onChange,
  allowedHosts,
  disabled = false,
  invalid = false,
}: Props) {
  const urlId = useId();
  const titleId = useId();
  const hostHintId = useId();

  const url = value?.url ?? '';
  const title = value?.title ?? '';

  /**
   * Both members are written together, and an empty pair clears the field.
   *
   * Emitting `{ url: '', title: '' }` instead would make an untouched embed a *present* value that
   * validation then refuses for a missing address — so an optional field nobody filled in would
   * block the save. Null is what "not filled in" means everywhere else here.
   */
  const write = (next: Partial<EmbedValue>) => {
    const merged = { url, title, ...next };
    onChange(merged.url.trim() === '' && merged.title.trim() === '' ? null : merged);
  };

  const status = hostStatus(url, allowedHosts);

  return (
    <div
      id={id}
      role="group"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className={`mt-1.5 space-y-3 rounded-md border px-3 py-3 ${
        invalid ? 'border-danger' : 'border-border-strong'
      }`}
    >
      <div>
        <label htmlFor={urlId} className="block text-sm font-medium">
          Address
        </label>
        <input
          id={urlId}
          type="url"
          inputMode="url"
          value={url}
          disabled={disabled}
          aria-describedby={hostHintId}
          onChange={(event) => write({ url: event.target.value })}
          placeholder="https://"
          className="mt-1 w-full rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-sm disabled:opacity-60"
        />

        <p
          id={hostHintId}
          className={`mt-1 flex items-start gap-1.5 text-xs ${
            status.kind === 'blocked' ? 'text-danger' : 'text-content-subtle'
          }`}
        >
          {status.kind === 'blocked' && (
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          )}
          {status.message}
        </p>
      </div>

      <div>
        <label htmlFor={titleId} className="block text-sm font-medium">
          Title
        </label>
        {/*
          Not optional, and the help text says why rather than just asking. An `<iframe>`'s
          accessible name is the only thing a screen reader can announce about it, so this is the
          same moment — and the same argument — as upload-in-place asking for alt text.
        */}
        <p className="mt-0.5 text-xs text-content-subtle">
          What this is, in a few words. Screen readers announce it, and an untitled frame is
          announced as “iframe”.
        </p>
        <input
          id={titleId}
          type="text"
          value={title}
          disabled={disabled}
          maxLength={300}
          onChange={(event) => write({ title: event.target.value })}
          placeholder="Campus tour video"
          className="mt-1 w-full rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-sm disabled:opacity-60"
        />
      </div>

      {status.kind === 'allowed' && (
        <p className="text-xs">
          <a
            href={status.href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-accent underline"
          >
            Open this in a new tab
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        </p>
      )}
    </div>
  );
}

type HostStatus =
  | { kind: 'empty' | 'incomplete' | 'blocked'; message: string }
  | { kind: 'allowed'; message: string; href: string };

/**
 * What to say under the address box, which is a different question at each stage of typing.
 *
 * **Nothing is judged until there is a plausible host**, and that rule is doing more work than it
 * looks like. `new URL('https://ww')` succeeds — hostname `ww` — so a check that judged anything
 * parseable would accuse somebody two keystrokes into typing `youtube.com`, and `new URL('http:')`
 * parses too, so it would flash "must use https" at somebody on their way to typing `https`. Both
 * are the failure mode the preview pane's connection hint already has a rule for: a hint that is
 * unsure is worse than no hint, because it teaches people to stop reading it.
 *
 * A dot is the test. Every host worth embedding has one, and the hosts that legitimately do not —
 * `localhost` — are not on anybody's allowlist, so staying quiet costs nothing and validation
 * refuses them at save time anyway.
 */
function hostStatus(raw: string, allowedHosts: string[]): HostStatus {
  const approved =
    allowedHosts.length > 0
      ? `Approved sites: ${allowedHosts.join(', ')}.`
      : 'This field has no approved sites yet. An administrator adds them in the field’s settings.';

  const trimmed = raw.trim();
  if (trimmed === '') return { kind: 'empty', message: approved };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { kind: 'incomplete', message: approved };
  }

  if (!parsed.hostname.includes('.')) return { kind: 'incomplete', message: approved };

  if (parsed.protocol !== 'https:') {
    return {
      kind: 'blocked',
      message:
        'Embeds must use https://. A browser refuses to frame an insecure page inside a secure one.',
    };
  }

  if (!embedHostAllowed(parsed.hostname, allowedHosts)) {
    return { kind: 'blocked', message: `${parsed.hostname} is not approved. ${approved}` };
  }

  return { kind: 'allowed', message: approved, href: parsed.toString() };
}

export default EmbedField;
