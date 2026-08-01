import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import {
  Bold,
  Code,
  Heading2,
  Heading3,
  Heading4,
  Italic,
  Link2,
  Link2Off,
  List,
  ListOrdered,
  Quote,
  SquareCode,
  Strikethrough,
} from 'lucide-react';

/**
 * The richtext editor.
 *
 * TipTap (ProseMirror) rather than a hand-rolled `contenteditable`: the hard parts of rich text are
 * selection, paste normalisation, and undo across a document model, and getting those wrong
 * produces markup that is subtly broken in ways editors notice and cannot fix.
 *
 * **The toolbar is where accessibility is decided.** It follows the WAI-ARIA toolbar pattern: one
 * tab stop for the whole group, arrow keys between buttons, `aria-pressed` for state. A row of
 * fifteen individually tabbable buttons in front of every richtext field would mean a keyboard user
 * pressing Tab fifteen times to reach the text they came to write.
 *
 * **What this component does not do is security.** Whatever it permits, the REST API accepts
 * richtext from any client with a session, so the value is sanitised server-side on write. The
 * toolbar shapes what an editor can produce; `sanitizeHtml` decides what can be stored.
 */

interface Props {
  id: string;
  value: string;
  onChange: (html: string) => void;
  /** Ids of the label, hint, and error text, so the editable region is properly named. */
  labelledBy: string;
  describedBy?: string;
  invalid?: boolean;
  /**
   * Tag names the field permits, matching the sanitiser's vocabulary so one list drives both.
   * Undefined means everything the toolbar offers.
   */
  allowedTags?: string[];
  /** Preview mode in the content-type builder: shows the toolbar, edits nothing. */
  disabled?: boolean;
}

/**
 * Toolbar buttons, each tagged with the element it produces.
 *
 * The tag is what `allowedFormats` filters on, so a field configured for inline formatting only
 * loses the heading buttons rather than offering an editor a control whose output the server would
 * silently unwrap.
 *
 * Underline is deliberately absent even though the sanitiser tolerates it: on the web, underlined
 * text that is not a link is a usability problem, and offering the button invites it. Existing
 * underlines in pasted content survive; nothing here creates new ones.
 */
interface ToolbarItem {
  tag: string;
  label: string;
  shortcut?: string;
  icon: typeof Bold;
  isActive: (editor: Editor) => boolean;
  run: (editor: Editor) => void;
}

const ITEMS: ToolbarItem[] = [
  {
    tag: 'strong',
    label: 'Bold',
    shortcut: 'Ctrl+B',
    icon: Bold,
    isActive: (e) => e.isActive('bold'),
    run: (e) => e.chain().focus().toggleBold().run(),
  },
  {
    tag: 'em',
    label: 'Italic',
    shortcut: 'Ctrl+I',
    icon: Italic,
    isActive: (e) => e.isActive('italic'),
    run: (e) => e.chain().focus().toggleItalic().run(),
  },
  {
    tag: 's',
    label: 'Strikethrough',
    icon: Strikethrough,
    isActive: (e) => e.isActive('strike'),
    run: (e) => e.chain().focus().toggleStrike().run(),
  },
  {
    tag: 'code',
    label: 'Inline code',
    icon: Code,
    isActive: (e) => e.isActive('code'),
    run: (e) => e.chain().focus().toggleCode().run(),
  },
  {
    tag: 'h2',
    label: 'Heading 2',
    icon: Heading2,
    isActive: (e) => e.isActive('heading', { level: 2 }),
    run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    tag: 'h3',
    label: 'Heading 3',
    icon: Heading3,
    isActive: (e) => e.isActive('heading', { level: 3 }),
    run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  {
    tag: 'h4',
    label: 'Heading 4',
    icon: Heading4,
    isActive: (e) => e.isActive('heading', { level: 4 }),
    run: (e) => e.chain().focus().toggleHeading({ level: 4 }).run(),
  },
  {
    tag: 'ul',
    label: 'Bulleted list',
    icon: List,
    isActive: (e) => e.isActive('bulletList'),
    run: (e) => e.chain().focus().toggleBulletList().run(),
  },
  {
    tag: 'ol',
    label: 'Numbered list',
    icon: ListOrdered,
    isActive: (e) => e.isActive('orderedList'),
    run: (e) => e.chain().focus().toggleOrderedList().run(),
  },
  {
    tag: 'blockquote',
    label: 'Quote',
    icon: Quote,
    isActive: (e) => e.isActive('blockquote'),
    run: (e) => e.chain().focus().toggleBlockquote().run(),
  },
  {
    tag: 'pre',
    label: 'Code block',
    icon: SquareCode,
    isActive: (e) => e.isActive('codeBlock'),
    run: (e) => e.chain().focus().toggleCodeBlock().run(),
  },
];

export function RichTextEditor({
  id,
  value,
  onChange,
  labelledBy,
  describedBy,
  invalid,
  allowedTags,
  disabled = false,
}: Props) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState('');
  const linkInputRef = useRef<HTMLInputElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  /** Which toolbar button holds the group's single tab stop. */
  const [focusIndex, setFocusIndex] = useState(0);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Only the levels the sanitiser keeps. The page's own <h1> is its title, so body content
        // starting at h2 is what keeps the document outline valid.
        heading: { levels: [2, 3, 4] },
        link: false,
      }),
      Link.configure({
        openOnClick: false,
        // Belt and braces with the server-side sanitiser: this stops a pasted `javascript:` URL
        // becoming a link in the editor at all, so an editor never sees one and thinks it worked.
        protocols: ['http', 'https', 'mailto', 'tel'],
        HTMLAttributes: { rel: 'noopener noreferrer' },
      }),
    ],
    content: value,
    editable: !disabled,
    // Astro server-renders islands, and ProseMirror needs a real DOM. Without this, TipTap throws
    // during SSR and the whole editor screen fails rather than just this field.
    immediatelyRender: false,
    editorProps: {
      attributes: {
        id,
        'aria-labelledby': labelledBy,
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
        ...(invalid ? { 'aria-invalid': 'true' } : {}),
        class: 'taproot-prose min-h-40 px-3 py-2 focus:outline-none',
      },
    },
    onUpdate: ({ editor: current }) => onChange(current.getHTML()),
  });

  /**
   * Accept an external change to `value` without fighting the editor.
   *
   * Comparing against the editor's own HTML first is what stops the cursor jumping to the end on
   * every keystroke: `onUpdate` sets state, the new value flows back down, and writing it back in
   * would reset the selection.
   */
  useEffect(() => {
    if (editor && !editor.isDestroyed && value !== editor.getHTML()) {
      editor.commands.setContent(value, { emitUpdate: false });
    }
  }, [editor, value]);

  const items = allowedTags ? ITEMS.filter((item) => allowedTags.includes(item.tag)) : ITEMS;
  const linkAllowed = !allowedTags || allowedTags.includes('a');
  const buttonCount = items.length + (linkAllowed ? (editor?.isActive('link') ? 2 : 1) : 0);

  /**
   * Roving tabindex.
   *
   * Arrow keys move focus within the toolbar and Tab leaves it, which is the ARIA toolbar pattern.
   * Focus is moved imperatively because the buttons are the DOM nodes that need it — tracking it in
   * state alone would only change which button is tabbable, not where focus actually is.
   */
  const moveFocus = useCallback(
    (next: number) => {
      const clamped = (next + buttonCount) % buttonCount;
      setFocusIndex(clamped);
      const buttons = toolbarRef.current?.querySelectorAll<HTMLButtonElement>('button');
      buttons?.[clamped]?.focus();
    },
    [buttonCount],
  );

  function onToolbarKeyDown(event: React.KeyboardEvent) {
    const keys: Record<string, number> = {
      ArrowRight: focusIndex + 1,
      ArrowLeft: focusIndex - 1,
      Home: 0,
      End: buttonCount - 1,
    };
    const next = keys[event.key];
    if (next === undefined) return;
    event.preventDefault();
    moveFocus(next);
  }

  useEffect(() => {
    if (linkOpen) linkInputRef.current?.focus();
  }, [linkOpen]);

  function openLinkForm() {
    if (!editor) return;
    setLinkValue(editor.getAttributes('link').href ?? '');
    setLinkOpen(true);
  }

  function applyLink(event: React.FormEvent) {
    event.preventDefault();
    if (!editor) return;

    const href = linkValue.trim();
    if (href) {
      editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    } else {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
    }

    setLinkOpen(false);
  }

  if (!editor) {
    // Pre-hydration and during SSR. A bordered box the size of the editor, so the screen does not
    // reflow when it appears.
    return (
      <div className="mt-1.5 min-h-52 rounded-md border border-border-strong bg-surface" aria-busy="true" />
    );
  }

  return (
    <div
      className={`mt-1.5 overflow-hidden rounded-md border bg-surface ${
        invalid ? 'border-danger' : 'border-border-strong'
      }`}
    >
      <div
        ref={toolbarRef}
        role="toolbar"
        aria-label="Text formatting"
        aria-controls={id}
        onKeyDown={onToolbarKeyDown}
        className="flex flex-wrap items-center gap-0.5 border-b border-border bg-surface-sunken px-1.5 py-1"
      >
        {items.map((item, index) => {
          const active = item.isActive(editor);
          const Icon = item.icon;
          return (
            <button
              key={item.tag}
              type="button"
              disabled={disabled}
              // `aria-pressed` rather than a visual-only highlight: "is this selection bold?" is
              // state, and a screen reader has no other way to learn it.
              aria-pressed={active}
              aria-label={item.shortcut ? `${item.label} (${item.shortcut})` : item.label}
              title={item.shortcut ? `${item.label} (${item.shortcut})` : item.label}
              tabIndex={index === focusIndex ? 0 : -1}
              onFocus={() => setFocusIndex(index)}
              onClick={() => item.run(editor)}
              className={`rounded p-1.5 transition-colors disabled:opacity-40 ${
                active ? 'bg-accent-subtle text-content' : 'hover:bg-surface'
              }`}
            >
              <Icon aria-hidden="true" size={16} />
            </button>
          );
        })}

        {linkAllowed && (
          <>
            <button
              type="button"
              disabled={disabled}
              aria-pressed={editor.isActive('link')}
              aria-label="Add or edit link"
              title="Add or edit link"
              aria-expanded={linkOpen}
              tabIndex={items.length === focusIndex ? 0 : -1}
              onFocus={() => setFocusIndex(items.length)}
              onClick={openLinkForm}
              className={`rounded p-1.5 transition-colors disabled:opacity-40 ${
                editor.isActive('link') ? 'bg-accent-subtle text-content' : 'hover:bg-surface'
              }`}
            >
              <Link2 aria-hidden="true" size={16} />
            </button>

            {editor.isActive('link') && (
              <button
                type="button"
                disabled={disabled}
                aria-label="Remove link"
                title="Remove link"
                tabIndex={items.length + 1 === focusIndex ? 0 : -1}
                onFocus={() => setFocusIndex(items.length + 1)}
                onClick={() => editor.chain().focus().extendMarkRange('link').unsetLink().run()}
                className="rounded p-1.5 transition-colors hover:bg-surface disabled:opacity-40"
              >
                <Link2Off aria-hidden="true" size={16} />
              </button>
            )}
          </>
        )}
      </div>

      {/*
        An inline form rather than `window.prompt`. The prompt is unstyleable, cannot show the
        existing href when editing a link, and is blocked outright in some embedded contexts.
      */}
      {linkOpen && (
        <form
          onSubmit={applyLink}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setLinkOpen(false);
            }
          }}
          className="flex flex-wrap items-end gap-2 border-b border-border bg-surface-sunken px-3 py-2"
        >
          <div className="min-w-48 flex-1">
            <label htmlFor={`${id}-link`} className="block text-xs font-medium">
              Link address
            </label>
            <input
              ref={linkInputRef}
              id={`${id}-link`}
              value={linkValue}
              placeholder="/admissions or https://example.edu"
              aria-describedby={`${id}-link-hint`}
              onChange={(e) => setLinkValue(e.target.value)}
              className="mt-1 w-full rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-sm"
            />
            <p id={`${id}-link-hint`} className="mt-1 text-xs text-content-subtle">
              A path on this site, or a full address. Leave blank to remove the link.
            </p>
          </div>
          <button
            type="submit"
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-content"
          >
            Apply
          </button>
          <button
            type="button"
            onClick={() => setLinkOpen(false)}
            className="rounded-md border border-border-strong px-3 py-1.5 text-sm font-medium"
          >
            Cancel
          </button>
        </form>
      )}

      <EditorContent editor={editor} />
    </div>
  );
}

export default RichTextEditor;
