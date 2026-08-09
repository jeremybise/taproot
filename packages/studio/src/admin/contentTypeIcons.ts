import { isIconName, type IconName } from './components/iconPaths.js';

/**
 * The marks a content type may choose for the sidebar.
 *
 * A subset of the generated set rather than all of it. The generator also carries icons that mean a
 * *fixed* destination — the dashboard, Settings, the media library — and offering those here invites
 * a content type that looks like the Settings link, which is worse than having no icon at all. This
 * list is the ones that describe a kind of content.
 *
 * **Nothing here assumes a particular kind of site.** The demo is a college and these are not
 * college icons; they are the shapes most content models reach for — a document, a date, a person, a
 * place, a container. A site whose content does not fit any of them keeps the default.
 */
export const CONTENT_TYPE_ICONS = [
  'file-text',
  'newspaper',
  'calendar',
  'user',
  'users',
  'building-2',
  'map-pin',
  'phone',
  'briefcase',
  'graduation-cap',
  'book-open',
  'award',
  'megaphone',
  'clipboard-list',
  'star',
  'folder',
  'image',
  'tags',
] as const satisfies readonly IconName[];

/**
 * Checked at module load rather than trusted.
 *
 * `as const satisfies readonly IconName[]` already fails the build if a name is not in the generated
 * set, which is the real guard. This is the runtime half for the case that matters at a different
 * time: the generator's `ICONS` list shrinking in a later edit, where a stale name here would render
 * an empty square in the picker and nothing would say why.
 */
export const contentTypeIcons: IconName[] = CONTENT_TYPE_ICONS.filter(isIconName);
