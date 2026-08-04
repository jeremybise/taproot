import CallToAction from './CallToAction.astro';
import EventListing from './EventListing.astro';
import Gallery from './Gallery.astro';
import Hero from './Hero.astro';
import Prose from './Prose.astro';
import Quote from './Quote.astro';

/**
 * This site's block templates, keyed by the block type's `api_id`.
 *
 * The map is the entire contract between Taproot and a site using it. Taproot stores what a block
 * *is* — its type and its validated field values — and has no opinion about what it looks like; a
 * CMS that shipped a hero component would be shipping a design, and the point of user-defined block
 * types is that a site invents the pieces it needs.
 *
 * Adding a block type in the admin and forgetting to add it here is the expected mistake, so
 * `BlockRenderer` shows a visible note in development for anything unmapped rather than failing
 * silently, and renders nothing in production rather than taking the page down.
 */
export const BLOCK_COMPONENTS = {
  hero: Hero,
  call_to_action: CallToAction,
  prose: Prose,
  quote: Quote,
  gallery: Gallery,
  event_listing: EventListing,
};
