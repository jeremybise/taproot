/**
 * The parts of core a *consumer* may hold: no database, no storage, no Kysely.
 *
 * `@taprootcms/astro` is a thin client that talks to a Taproot server over HTTP, and it must not drag
 * the data layer into a site's bundle. Importing from the main entry would: the barrel re-exports
 * `db/index.js`, which pulls Kysely and the dialect loaders, none of which a consumer can use and
 * all of which it would ship.
 *
 * Two kinds of thing are safe to share, and this file is exactly those:
 *
 *  - **Pure functions with no imports at all.** `imageCrop` is the whole of it today — resolving a
 *    stored hotspot and crop into a rectangle is arithmetic, and the alternative to sharing it is a
 *    second copy that drifts from the one the admin's preview uses. A preview that disagreed with
 *    the rendered page is precisely the bug `TaprootImage` was written to fix.
 *  - **Types.** `export type` is erased at build, so the delivery response shapes cost a consumer
 *    nothing at runtime while keeping one definition for both sides of the wire. Two hand-kept
 *    copies of a wire format is how a client and a server stop agreeing.
 *
 * Nothing with a database import may be added here. The check is not subtle: if it needs `Kysely`,
 * it belongs in the main entry.
 */

export * from './content/imageCrop.js';

/**
 * `imageVariants` — the `?w=` / `?f=` vocabulary the media route answers and a consumer builds
 * `srcset` from. Shared for the reason `cacheTags` is: a spelling that differs between the two
 * sides fails silently, serving every visitor the full-size original while every test passes.
 */
export * from './content/imageVariants.js';
export * from './content/menuHrefs.js';
/**
 * `queryKey` — how a consumer finds a listing's results in the response's `queries` map.
 *
 * Its own module for the same reason `menuHrefs` is one: the resolver beside it needs Kysely, and a
 * consumer that imported that would drag the whole data layer into its bundle. One implementation
 * of the key on both sides, because a mismatched key fails by returning `undefined` — a listing that
 * renders nothing and reports nothing.
 */
export * from './content/queryKeys.js';
/**
 * Previous, next and up within a book, computed from an outline the caller already has.
 *
 * Here rather than in the studio because the site is what renders the control: a book page fetches
 * its outline once for the table of contents, and navigation is arithmetic over that array. The
 * alternative was a materialised reading-order column, which renumbers every later section whenever
 * somebody inserts one — a cascading write on an ordinary save, to save a read that costs nothing.
 * Importless, so a consumer's bundle pays only for the arithmetic.
 */
export * from './content/bookNav.js';
/**
 * The cache-tag vocabulary, shared by the two caches that use it.
 *
 * The studio tags its cached delivery JSON; a consumer tags the HTML it renders from that JSON, and
 * mounts a purge endpoint the CMS calls. Both have to spell a tag identically or the purge succeeds,
 * reports success, and clears nothing — a failure with no symptom until somebody notices the site
 * showing last week's front page. Importless, so it costs a consumer's bundle nothing.
 */
export * from './content/cacheTags.js';
/**
 * `embeds` — the sizing modes, the height ceiling, and the default `postMessage` height parser.
 *
 * Shared for the reason the two above are: `<TaprootEmbed>` clamps a height reported by another
 * origin and switches on a sizing mode the CMS stored, and a second copy of either is how the frame
 * a site renders stops matching the frame the admin configured. The host allowlist travels with them
 * even though only the server enforces it — one spelling of "is this domain covered" is worth more
 * than the bytes, and a consumer that wants to explain a blocked embed has the same answer.
 */
export * from './content/embeds.js';
/**
 * `searchTokens` and `highlightTerms` — how a search string is split, and how the excerpt it
 * produced is marked up.
 *
 * Shared for the reason the four above are, with one addition: the server *matches* with these
 * tokens and the consumer *highlights* with them, so a second copy does not fail loudly, it marks
 * the wrong words on a page of correct results. `highlightTerms` returns segments rather than HTML
 * precisely so the consumer never reaches for `set:html` on a string built from `?q=`.
 */
export * from './content/searchTerms.js';

/**
 * The `{{ tuition }}` token grammar.
 *
 * Shared for the same reason again, and the failure mode is the quiet one: delivery substitutes
 * these before a consumer ever sees them, so a site that wants to *find* a token — to highlight one
 * in an editor preview, or to warn about an unresolved one — has to match exactly what the server
 * matched. A second regex that is nearly right marks nothing, or marks a stray brace, and neither
 * shows up as an error anywhere.
 *
 * Importless, so it costs a consumer nothing but the function.
 */
export * from './content/snippetTokens.js';
/**
 * Webhook signing, and the payload a receiver is handed.
 *
 * The sharpest instance of the rule the four above follow. The CMS signs through the main barrel and
 * a site verifies through `/pure`, and a verifier that is subtly different from the signer does not
 * receive wrong events — it receives **none**, answering 401 in a log nobody watches, while the CMS
 * reports every delivery as failed and the endpoint that looks broken is the one that is correct.
 * `crypto.subtle` is in both runtimes, so the same function genuinely runs on both sides.
 *
 * `events.js` rides along for the types: a consumer's handler switches on `WebhookEvent` and reads
 * `WebhookEventPayload`, both erased at build.
 */
export * from './webhooks/signature.js';
export * from './webhooks/events.js';
export type { ItemSort } from './content/itemSort.js';
export type { SnippetKind } from './db/schema.js';
export type { ResolvedSnippet } from './content/snippets.js';
/**
 * The query parameter a preview link travels in.
 *
 * Declared *here* rather than beside the token logic, because this is the only entry both sides of
 * the wire can import: `preview.ts` needs Kysely and a consumer must never see it. The server reads
 * this constant through the main barrel, the client through `/pure`, and there is exactly one
 * string — a second copy is how the two ends stop agreeing on a name.
 */
export const PREVIEW_PARAM = 'taproot_preview';

/**
 * The path a consumer mounts its cache-purge endpoint at, and the header the CMS authenticates with.
 *
 * Here for the reason `PREVIEW_PARAM` is: the CMS builds the request through the main barrel and the
 * consumer's handler reads it through `/pure`, so there is exactly one spelling. A mismatch here
 * fails **silently and in the worst direction** — the CMS would POST to a path that 404s, the purge
 * would be recorded as failed, retried eight times, and the site would serve stale pages while
 * every save reported success.
 *
 * A header rather than a bearer token in the URL, because a URL lands in access logs — the same
 * reasoning that keeps a freshly minted API key out of a query string.
 *
 * **No leading underscore, and that is not cosmetic.** This was `/_taproot/purge` for exactly one
 * release, and **Astro excludes any file or directory in `src/pages` whose name starts with `_`
 * from routing** — so the endpoint silently did not exist. It type-checked, it built without a
 * warning, the route string appeared in the bundle (as a doc comment), and every purge the CMS sent
 * would have 404'd, been queued as failed, retried eight times and reported on Settings → System as
 * a problem with no cause visible anywhere in the code. Found only by grepping the built output for
 * the handler and not finding it. `purgePathIsRoutable` in `cacheTags.test.ts` is what stops it
 * coming back.
 *
 * The path is otherwise only a *convention*: `createTaprootPurgeHandler` works wherever it is
 * mounted, and `TAPROOT_SITE_PURGE_URL` is a full URL rather than an origin, so a site that already
 * owns `/taproot/*` can put it elsewhere — as long as it avoids the underscore too. What the
 * constant buys is that the documented default and the scaffolded example cannot drift apart.
 */
export const PURGE_PATH = '/taproot/purge';
export const PURGE_SECRET_HEADER = 'x-taproot-purge-secret';

/**
 * The postMessage vocabulary the split-view preview pane and the consumer's bridge share.
 *
 * Here for the same reason `PREVIEW_PARAM` is: the pane reads it through the main barrel and the
 * bridge through `/pure`, so there is exactly one spelling of each name. Two hand-kept copies is how
 * a handshake starts failing silently in one direction — and silently is the only way it can fail,
 * because the pane's fallback is to reload the frame anyway.
 *
 * The child never posts to `'*'`. It learns the CMS's origin from `event.origin` of the hello, which
 * is why nothing here needs configuring and why a hostile framer gets no reply.
 */
export const PREVIEW_MESSAGE = {
  /** CMS → site, once the frame has loaded. */
  hello: 'taproot:preview:hello',
  /** Site → CMS, answering a hello. Its arrival is what tells the pane a bridge is present. */
  ready: 'taproot:preview:ready',
  /** CMS → site. Reloading from *inside* the frame is what keeps the scroll position. */
  refresh: 'taproot:preview:refresh',
} as const;

export type {
  DeliveryField,
  DeliveryItem,
  DeliveryItemRef,
  DeliveryList,
  DeliveryListItem,
  DeliveryMedia,
  DeliveryMenuItem,
  DeliveryMenuTarget,
  DeliveryResult,
  DeliverySchema,
  DeliveryTaxonomy,
  DeliveryTaxonomySummary,
  DeliveryTaxonomyTerm,
  DeliveryTermRef,
  DeliveryTypeSchema,
} from './content/delivery.js';

export type { DeliveryQueryResult } from './content/itemQueries.js';

/**
 * Type-only, because `bookOutline.ts` reaches the database and `bookNav.ts` does not.
 *
 * A consumer needs the shape to type its table of contents and to hand `entries` to
 * `bookNavigation`; it must never reach the function that builds one. `export type` is erased at
 * build, so this costs the consumer's bundle nothing — the same arrangement every `Delivery*` type
 * above already has.
 */
export type { BookOutline, BookOutlineEntry } from './content/bookOutline.js';

export type { ContentStatus, ContentTypeKind, FieldType } from './db/schema.js';
