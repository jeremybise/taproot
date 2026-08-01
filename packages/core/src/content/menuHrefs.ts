import type { DeliveryMenuItem } from './delivery.js';

/**
 * Turn delivered menu entries into hrefs, applying the site's own term-URL policy.
 *
 * The other half of the callback that could not cross the wire. `resolveMenu` takes a `termHref`
 * function, and a function cannot be serialised — so the delivery API returns term targets
 * *unresolved* and the consumer supplies exactly the resolver it would have passed, on its own side.
 * "Taproot has no opinion about term URLs" survives the split that way, where a server-side setting
 * for which taxonomies get pages would have made the CMS assert something only the site knows.
 *
 * In its own module rather than in `delivery.ts` because it has to be reachable from
 * `@taprootcms/core/pure`: a consumer runs this, and `delivery.ts` imports Kysely. Nothing here does —
 * the only import is a type, which is erased at build.
 */

export interface MenuHrefTarget {
  id: string;
  name: string;
  slug: string;
  taxonomyApiId: string;
}

export interface MenuLink {
  id: string;
  label: string;
  href: string;
  openInNewTab: boolean;
  children: MenuLink[];
}

export function applyTermHrefs(
  items: DeliveryMenuItem[],
  termHref: (term: MenuHrefTarget) => string | null,
): MenuLink[] {
  return items
    .map((entry): MenuLink | null => {
      const href =
        entry.target.type === 'item'
          ? entry.target.path
          : entry.target.type === 'url'
            ? entry.target.url
            : termHref(entry.target);

      // A term the site publishes no page for drops out, which is what `resolveMenu` does with the
      // same answer. Nothing is wrong — there is simply nowhere to link to.
      if (href === null) return null;

      return {
        id: entry.id,
        label: entry.label,
        href,
        openInNewTab: entry.openInNewTab,
        children: applyTermHrefs(entry.children, termHref),
      };
    })
    .filter((entry): entry is MenuLink => entry !== null);
}
