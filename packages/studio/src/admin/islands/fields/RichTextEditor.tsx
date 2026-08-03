import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
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

import { LinkDialog, linkModeFor, type LinkMode, type LinkOptions } from './LinkDialog.js';
import type { MediaOption } from '../../mediaOptions.js';

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
  /**
   * The media library's first page, so the link dialog's file panel opens with something in it.
   *
   * Only links: an image cannot be placed in prose — see `sanitizeHtml`, where `img` is absent and
   * stays absent — so what this produces is always an `<a>`.
   */
  media?: MediaOption[];
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
  media = [],
}: Props) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkMode, setLinkMode] = useState<LinkMode>('url');
  /**
   * Where the caret was when the dialog opened.
   *
   * A modal takes focus, and the browser's selection inside the editor goes with it. Every path
   * that applies a link therefore works from this range rather than from wherever the document
   * thinks the caret is by the time Apply is pressed — which is what keeps "select a phrase, press
   * the link button, choose a page" wrapping the phrase instead of appending a title next to it.
   */
  const savedRange = useRef<{ from: number; to: number } | null>(null);
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
        /**
         * Belt and braces with the server-side sanitiser: this stops a pasted `javascript:` URL
         * becoming a link in the editor at all, so an editor never sees one and thinks it worked.
         *
         * `taproot` has to be here or the whole internal-link feature is inert — TipTap validates
         * every href against this list and silently drops the mark, so choosing a page produced a
         * form that closed and no link. `optionalSlashes` because a reference is `taproot:item:{id}`
         * with no `//`, which the default matcher requires.
         */
        protocols: [
          'http',
          'https',
          'mailto',
          'tel',
          { scheme: 'taproot', optionalSlashes: true },
        ],
        /**
         * `target: null` is doing real work here.
         *
         * TipTap's Link ships `target: '_blank'` in its own defaults and `HTMLAttributes` *merges*
         * rather than replaces, so overriding only `rel` left every link this editor has ever made
         * opening in a new tab — including a link from one page of the site to another. Nobody asked
         * for that, and it is most obviously wrong on an internal reference.
         *
         * `rel` stays: the server adds it too whenever it emits `target="_blank"`, and matching here
         * means what the editor shows is what gets stored.
         */
        HTMLAttributes: { target: null, rel: 'noopener noreferrer' },
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

  /**
   * What the cursor is currently inside, kept in step with the document.
   *
   * **TipTap 3 changed the default here and it is not obvious.** `useEditor` no longer re-renders on
   * every transaction, so `editor.isActive(…)` read straight in the render body is evaluated once
   * and then frozen: the H2 button stayed lit wherever the caret went, the list buttons never lit at
   * all, and Unlink was offered on text that was not a link. Nothing errors — the toolbar simply
   * stops telling the truth.
   *
   * `useEditorState` subscribes properly and re-renders only when one of these values changes, which
   * is the point of it over turning blanket re-rendering back on: this runs on every keystroke.
   *
   * The selector returns **primitives only**, flat. Anything nested defeats the equality check that
   * makes it worth using, and it would re-render on every transaction after all.
   */
  const live = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      if (!current) return null;
      return {
        // One character per button, in `items` order — a string so the comparison stays shallow.
        activeMask: items.map((item) => (item.isActive(current) ? '1' : '0')).join(''),
        isLink: current.isActive('link'),
        linkHref: (current.getAttributes('link').href as string | undefined) ?? '',
        linkTarget: (current.getAttributes('link').target as string | undefined) ?? '',
        linkRel: (current.getAttributes('link').rel as string | undefined) ?? '',
      };
    },
  });

  const isLink = live?.isLink ?? false;

  /**
   * How many buttons the roving tabindex spans, derived rather than hardcoded.
   *
   * The unlink button only exists while the cursor is in a link, so a literal count goes stale the
   * moment the caret moves — and a button missing from it is one End and the arrow-key wrap can
   * never reach, which is the toolbar pattern's whole promise broken.
   */
  const linkButtons = linkAllowed ? (isLink ? 2 : 1) : 0;
  const buttonCount = items.length + linkButtons;

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

  /**
   * Ctrl/Cmd + K opens the link dialog.
   *
   * On the wrapper rather than in `editorProps.handleKeyDown`, which is fixed at editor creation and
   * would close over an `openLinkDialog` whose `editor` is still undefined. `preventDefault` matters:
   * unclaimed, this is the browser's own address-bar shortcut.
   */
  function onWrapperKeyDown(event: React.KeyboardEvent) {
    if (!linkAllowed || disabled) return;
    if (event.key !== 'k' || !(event.metaKey || event.ctrlKey) || event.altKey) return;
    event.preventDefault();
    openLinkDialog();
  }

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

  /**
   * Open the dialog on the panel that matches the link already there.
   *
   * There is one way in, which is why there is one button. A separate paperclip opened the same
   * dialog on its file panel and was a shortcut worth having while the alternative was a cramped
   * inline form — but two toolbar icons for one dialog is two things to learn and one of them
   * redundant, and the panel it jumped to is one click away.
   */
  function openLinkDialog() {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    savedRange.current = { from, to };
    setLinkMode(linkModeFor(editor.getAttributes('link').href));
    setLinkOpen(true);
  }

  /**
   * Closing clears the captured range, and that is what keeps one `removeLink` honest.
   *
   * The toolbar unlink button and the dialog both call it, but they mean different positions: the
   * toolbar means wherever the caret is now, the dialog means where it was before the modal took
   * focus. A range left behind after the dialog closed would make the toolbar button act on a
   * position from the last time it was opened — the sort of thing that looks like nothing at all
   * until it silently unlinks the wrong phrase.
   */
  function closeLinkDialog() {
    savedRange.current = null;
    setLinkOpen(false);
  }

  /** The range to act on: what was captured on open, or the live caret if there is none. */
  function targetRange() {
    if (savedRange.current) return savedRange.current;
    const { from, to } = editor!.state.selection;
    return { from, to };
  }

  function removeLink() {
    editor
      ?.chain()
      .focus()
      .setTextSelection(targetRange())
      .extendMarkRange('link')
      .unsetLink()
      .run();
    closeLinkDialog();
  }

  /**
   * Store the reference rather than the path, so the link follows the page.
   *
   * `label` is a parameter and not state the caller just set: a `setState` before this call has not
   * landed by the time it runs, so reading it here inserted an empty anchor the first time and the
   * *previous* title every time after.
   *
   * `rel` carries only what the author asked for; the server adds `noopener noreferrer` to anything
   * opening in a new tab and will not let that be removed, so there is nothing to duplicate here.
   */
  function applyTarget(href: string, label: string, options: LinkOptions) {
    if (!editor) return;

    const range = targetRange();
    const attrs = {
      href,
      target: options.newTab ? '_blank' : null,
      rel: options.noFollow ? 'nofollow' : null,
    };

    /**
     * Two branches, and both are needed however the link was chosen.
     *
     * `setLink` marks a selection. With the caret collapsed there is nothing to mark, so it succeeds
     * and produces nothing visible — which from the outside is exactly "I pressed apply and no link
     * appeared". When there is no selection the link has to bring its own text, inserted as a text
     * node carrying the mark: `insertContent` with an HTML string escapes it and puts a literal
     * `<a href=…>` into the prose.
     *
     * Both act on the captured range rather than on the live selection, because the dialog took
     * focus and the browser's selection went with it.
     */
    if (range.from === range.to) {
      editor
        .chain()
        .focus()
        .insertContentAt(range, { type: 'text', text: label, marks: [{ type: 'link', attrs }] })
        .run();
    } else {
      editor.chain().focus().setTextSelection(range).extendMarkRange('link').setLink(attrs).run();
    }

    closeLinkDialog();
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
      onKeyDown={onWrapperKeyDown}
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
          const active = live?.activeMask[index] === '1';
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
              aria-pressed={isLink}
              aria-label="Add or edit link"
              title="Add or edit link"
              aria-haspopup="dialog"
              tabIndex={items.length === focusIndex ? 0 : -1}
              onFocus={() => setFocusIndex(items.length)}
              onClick={() => openLinkDialog()}
              className={`rounded p-1.5 transition-colors disabled:opacity-40 ${
                isLink ? 'bg-accent-subtle text-content' : 'hover:bg-surface'
              }`}
            >
              <Link2 aria-hidden="true" size={16} />
            </button>

            {isLink && (
              <button
                type="button"
                disabled={disabled}
                aria-label="Remove link"
                title="Remove link"
                tabIndex={items.length + 1 === focusIndex ? 0 : -1}
                onFocus={() => setFocusIndex(items.length + 1)}
                onClick={removeLink}
                className="rounded p-1.5 transition-colors hover:bg-surface disabled:opacity-40"
              >
                <Link2Off aria-hidden="true" size={16} />
              </button>
            )}
          </>
        )}
      </div>

      {/*
        Every kind of link, in one dialog.

        Mounted only while open, following `MediaField`: Radix portals its content, and a closed one
        left mounted costs a subscription per richtext field on a screen that can carry several.

        It produces an `<a>`, never an `<img>` — images belong to a block, where they keep their
        hotspot and their alt text. A page or a file is stored as `taproot:{kind}:{id}`, so renaming
        the page or replacing the asset keeps the link working.
      */}
      {linkOpen && (
        <LinkDialog
          open={linkOpen}
          onOpenChange={(next) => (next ? setLinkOpen(true) : closeLinkDialog())}
          current={live?.isLink ? { href: live.linkHref, target: live.linkTarget, rel: live.linkRel } : null}
          initialMode={linkMode}
          media={media}
          onApply={applyTarget}
          onRemove={removeLink}
        />
      )}

      <EditorContent editor={editor} />
    </div>
  );
}

export default RichTextEditor;
