import { ICON_PATHS, isIconName } from './iconPaths.js';

/**
 * The React half of `Icon.astro`, drawing from the same generated data.
 *
 * Two renderers over one dataset, which is the arrangement `useDismissable.ts` and `UserMenu.astro`
 * already use for disclosures: an `.astro` component cannot be rendered inside an island and a React
 * one cannot be rendered in an Astro template, so the *code* has to exist twice. What must not exist
 * twice is the geometry — both read `iconPaths.ts`, so the mark beside a content type in the sidebar
 * and the mark in the picker that chose it are the same by construction.
 *
 * `lucide-react` is available here and is deliberately not used: it would need a name-to-component
 * map maintained beside the generated list, and the two would drift the first time somebody added an
 * icon to one and not the other. That is the whole failure the generator exists to prevent.
 */
export function IconInline({ name, className = 'h-4 w-4' }: { name: string; className?: string }) {
  // Unknown names draw nothing, matching `Icon.astro` — a stored icon name outlives the set it
  // names, and a missing decoration must never be what breaks a screen.
  if (!isIconName(name)) return null;

  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICON_PATHS[name].map((shape, index) => {
        const attrs = shape.attrs as Record<string, string>;
        /*
          Widened deliberately. `ICON_PATHS` is `as const`, so `tag` narrows to the shapes the
          *current* icon list happens to use — today that excludes polyline and polygon, and TypeScript
          then rejects those branches as unreachable. Keeping them costs nothing and means adding an
          icon that needs one is a generator edit rather than a generator edit plus this file.
        */
        const tag: string = shape.tag;
        switch (tag) {
          case 'circle':
            return <circle key={index} {...attrs} />;
          case 'rect':
            return <rect key={index} {...attrs} />;
          case 'line':
            return <line key={index} {...attrs} />;
          case 'polyline':
            return <polyline key={index} {...attrs} />;
          case 'polygon':
            return <polygon key={index} {...attrs} />;
          case 'ellipse':
            return <ellipse key={index} {...attrs} />;
          default:
            return <path key={index} {...attrs} />;
        }
      })}
    </svg>
  );
}

export default IconInline;
