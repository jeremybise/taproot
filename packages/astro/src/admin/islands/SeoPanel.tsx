import { useId } from 'react';
import { SEO_GUIDANCE, resolveSeo, truncateForPreview, type SeoData } from '@taproot/core';

/**
 * The SEO panel: the fields, plus a preview of what they produce.
 *
 * The previews are the reason this exists. Meta title and description are the only fields in the
 * editor whose audience never sees the CMS, so an editor writing them has no feedback at all —
 * they find out a title was cut off when someone shows them a search result. Rendering an
 * approximation next to the inputs turns that into something you notice while typing.
 *
 * Fallbacks are resolved by `resolveSeo` in core, the same function the public route calls. A
 * preview that resolved its own fallbacks would be a preview of a page nobody will ever see.
 */

export interface MediaOption {
  id: string;
  filename: string;
  url: string;
  altText: string | null;
}

interface Props {
  seo: SeoData;
  onChange: (seo: SeoData) => void;
  /** The item's own title, which is what the meta title falls back to. */
  itemTitle: string;
  /** The path this item resolves at, shown in the preview's URL line. */
  path: string;
  /** Site origin for the preview URL. The real canonical is computed server-side at render. */
  origin: string;
  images: MediaOption[];
  /** The content type's default social image, inherited when the item sets none. */
  defaultOgImage: MediaOption | null;
}

export default function SeoPanel({
  seo,
  onChange,
  itemTitle,
  path,
  origin,
  images,
  defaultOgImage,
}: Props) {
  const id = useId();
  const set = (patch: Partial<SeoData>) => onChange({ ...seo, ...patch });

  // The content type is reduced to the one field resolveSeo reads, so this component does not need
  // a whole ContentTypeRow just to answer "what image would this inherit?".
  const resolved = resolveSeo(
    { title: itemTitle, seo },
    { default_og_image_id: defaultOgImage?.id ?? null },
  );

  const previewImage =
    resolved.ogImageSource === 'item'
      ? (images.find((image) => image.id === resolved.ogImageId) ?? null)
      : resolved.ogImageSource === 'contentType'
        ? defaultOgImage
        : null;

  const titleLength = (seo.metaTitle ?? '').trim().length;
  const descriptionLength = (seo.metaDescription ?? '').trim().length;
  const titleLong = titleLength > SEO_GUIDANCE.titleChars;
  const descriptionLong = descriptionLength > SEO_GUIDANCE.descriptionChars;

  const displayHost = hostOf(origin);

  return (
    <section aria-labelledby={`${id}-heading`} className="rounded-lg border border-border bg-surface-raised p-4">
      <h2 id={`${id}-heading`} className="text-sm font-semibold">
        Search &amp; social
      </h2>
      <p className="mt-1 text-xs text-content-subtle">
        How this page looks in search results and when someone shares it. Leave a field blank to
        use the page's own title.
      </p>

      {/* Fields ---------------------------------------------------------- */}
      <div className="mt-4">
        <label htmlFor={`${id}-title`} className="block text-sm font-medium">
          Meta title
        </label>
        <input
          id={`${id}-title`}
          value={seo.metaTitle ?? ''}
          placeholder={itemTitle}
          aria-describedby={`${id}-title-count`}
          onChange={(e) => set({ metaTitle: e.target.value })}
          className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm"
        />
        <CharacterCount
          id={`${id}-title-count`}
          length={titleLength}
          guidance={SEO_GUIDANCE.titleChars}
          over={titleLong}
          noun="title"
        />
      </div>

      <div className="mt-4">
        <label htmlFor={`${id}-description`} className="block text-sm font-medium">
          Meta description
        </label>
        <textarea
          id={`${id}-description`}
          rows={3}
          value={seo.metaDescription ?? ''}
          aria-describedby={`${id}-description-count`}
          onChange={(e) => set({ metaDescription: e.target.value })}
          className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm"
        />
        <CharacterCount
          id={`${id}-description-count`}
          length={descriptionLength}
          guidance={SEO_GUIDANCE.descriptionChars}
          over={descriptionLong}
          noun="description"
        />
      </div>

      <div className="mt-4">
        <label htmlFor={`${id}-og`} className="block text-sm font-medium">
          Social image
        </label>
        {/*
          A select rather than a media browser. The real library picker — grid, search, upload in
          place — arrives with the `media` field type, and this moves to it then; shipping a second
          bespoke picker now would mean two to replace.
        */}
        <select
          id={`${id}-og`}
          value={seo.ogImageId ?? ''}
          aria-describedby={`${id}-og-hint`}
          onChange={(e) => set({ ogImageId: e.target.value || undefined })}
          className="mt-1.5 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm"
        >
          <option value="">
            {defaultOgImage
              ? `— Use this type's default: ${defaultOgImage.filename} —`
              : '— None —'}
          </option>
          {images.map((image) => (
            <option key={image.id} value={image.id}>
              {image.filename}
            </option>
          ))}
        </select>
        <p id={`${id}-og-hint`} className="mt-1 text-xs text-content-subtle">
          {images.length === 0
            ? 'Upload an image in Media to choose one here.'
            : resolved.ogImageSource === 'contentType'
              ? 'Inherited from the content type. Changing it there updates every item that has not chosen its own.'
              : 'Shown when the page is shared. Around 1200×630 works everywhere.'}
        </p>
      </div>

      <div className="mt-4 flex items-start gap-2">
        <input
          id={`${id}-noindex`}
          type="checkbox"
          checked={seo.noIndex === true}
          aria-describedby={`${id}-noindex-hint`}
          onChange={(e) => set({ noIndex: e.target.checked || undefined })}
          className="mt-0.5"
        />
        <div>
          <label htmlFor={`${id}-noindex`} className="text-sm font-medium">
            Hide from search engines
          </label>
          <p id={`${id}-noindex-hint`} className="text-xs text-content-subtle">
            Adds <code className="font-mono">noindex</code>. The page stays public to anyone with
            the link — this is not a way to make it private.
          </p>
        </div>
      </div>

      {/* Previews -------------------------------------------------------- */}
      <h3 className="mt-6 text-xs font-semibold uppercase tracking-wide text-content-subtle">
        Search result
      </h3>
      {/*
        `aria-hidden` on both previews: every word in them is already in an input above, and the
        underlying values are announced there with a real label. Leaving them in the accessibility
        tree would make a screen reader read the whole title and description twice on every keystroke.
      */}
      <div
        aria-hidden="true"
        className="mt-2 rounded-md border border-border bg-surface px-3 py-2.5"
      >
        <p className="truncate text-xs text-content-muted">
          {displayHost}
          <span className="text-content-subtle">{path === '/' ? '' : path.replace(/\//g, ' › ')}</span>
        </p>
        <p className="mt-0.5 text-sm text-[#1a0dab] dark:text-[#8ab4f8]">
          {truncateForPreview(resolved.title, SEO_GUIDANCE.titleChars)}
        </p>
        <p className="mt-0.5 text-xs leading-snug text-content-muted">
          {resolved.description
            ? truncateForPreview(resolved.description, SEO_GUIDANCE.descriptionChars)
            : 'No meta description — a search engine will pick a snippet from the page.'}
        </p>
      </div>

      <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-content-subtle">
        Shared link
      </h3>
      <div aria-hidden="true" className="mt-2 overflow-hidden rounded-md border border-border">
        <div className="flex aspect-[1.91/1] items-center justify-center bg-surface-sunken">
          {previewImage ? (
            <img src={previewImage.url} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="px-3 text-center text-xs text-content-subtle">
              No image — most platforms show a plain text link
            </span>
          )}
        </div>
        <div className="bg-surface px-3 py-2">
          <p className="text-[0.6875rem] uppercase tracking-wide text-content-subtle">
            {displayHost}
          </p>
          <p className="mt-0.5 truncate text-sm font-medium">{resolved.title}</p>
          {resolved.description && (
            <p className="mt-0.5 line-clamp-2 text-xs text-content-muted">{resolved.description}</p>
          )}
        </div>
      </div>

      <p className="mt-3 text-xs text-content-subtle">
        An approximation. Search engines rewrite titles and snippets when they judge a different
        one fits the query better, and each social platform crops its card differently.
      </p>
    </section>
  );
}

/**
 * A live character count.
 *
 * `aria-live="polite"` on the message but not the number: announcing a count on every keystroke
 * is unusable, while announcing "longer than the usual cut-off" once as it crosses the threshold
 * is the part worth hearing. The count itself is read on demand because it is in the input's
 * `aria-describedby`.
 */
function CharacterCount({
  id,
  length,
  guidance,
  over,
  noun,
}: {
  id: string;
  length: number;
  guidance: number;
  over: boolean;
  noun: string;
}) {
  return (
    <p id={id} className="mt-1 flex flex-wrap items-baseline gap-x-2 text-xs">
      <span className={over ? 'text-warning' : 'text-content-subtle'}>
        {length} characters, around {guidance} usually shown
      </span>
      <span aria-live="polite" className={over ? 'font-medium text-warning' : 'sr-only-focusable'}>
        {over ? `This ${noun} will probably be cut off.` : ''}
      </span>
    </p>
  );
}

/** Host for the preview URL line, falling back to the raw string if it will not parse. */
function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}
