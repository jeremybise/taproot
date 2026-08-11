import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SITE_TAG, type User } from '@taprootcms/core';

import { createHarness, body, location, type Harness } from './testHarness.js';
import { POST as uploadPost } from './media/index.js';
import { POST as describePost } from './media/describe.js';

/**
 * Multi-upload and the bulk describe endpoint.
 *
 * The alt-text rules get the most attention here, and the reason is that **every way of getting
 * them wrong is silent**. Reading a blank box as decorative empties the accessibility report of
 * exactly the images that still need work; reading it as a description writes `''` where `null`
 * belongs. Neither errors, neither looks wrong on screen, and both make the report stop being
 * worth reading — which is the only thing that would have caught them.
 */
let h: Harness;
let contributor: User;

beforeEach(async () => {
  h = await createHarness();
  contributor = await h.user('contributor');
  h.as(contributor);
});

afterEach(async () => {
  await h.destroy();
});

/** A PNG header, so `readImageDimensions` recognises it and the row looks like a real image. */
function png(name: string, width = 4, height = 4, padding = 0): File {
  const header = new Uint8Array(24 + padding);
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  // IHDR length + type, then the two big-endian dimensions the reader looks for.
  header.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(header.buffer).setUint32(16, width);
  new DataView(header.buffer).setUint32(20, height);
  return new File([header], name, { type: 'image/png' });
}

function upload(files: File[], extra: Record<string, string> = {}) {
  const form = new FormData();
  for (const file of files) form.append('file', file);
  for (const [key, value] of Object.entries(extra)) form.set(key, value);
  return h.context({
    method: 'POST',
    url: '/api/taproot/media',
    formData: form,
    headers: { accept: 'text/html' },
  });
}

async function rows() {
  return h.db.db.selectFrom('media').selectAll().orderBy('filename').execute();
}

describe('multi-upload', () => {
  it('writes every file in one post', async () => {
    const response = await uploadPost(upload([png('a.png'), png('b.png'), png('c.png')]));

    expect(response.status).toBe(303);
    expect(await rows()).toHaveLength(3);
  });

  it('sends a browser to the describe screen carrying exactly the new ids', async () => {
    const response = await uploadPost(upload([png('a.png'), png('b.png')]));
    const target = location(response);

    expect(target).toContain('/admin/media/describe');

    /*
     * The ids, not a re-query for "undescribed". A batch uploaded into a library that already holds
     * fifty undescribed assets must open on the two just added, not on fifty-two strangers.
     */
    const ids = new URL(target, 'http://x').searchParams.get('ids')!.split(',');
    expect(ids).toHaveLength(2);
    expect(new Set(ids)).toEqual(new Set((await rows()).map((row) => row.id)));
  });

  it('leaves a batch undescribed rather than applying one alt box to all of it', async () => {
    // The library's form has no alt input precisely so this cannot happen; the route enforces it
    // anyway, because a caller can still post one. Writing the same sentence onto twenty images is
    // worse than leaving them undescribed: it looks done and describes nineteen of them wrongly.
    await uploadPost(upload([png('a.png'), png('b.png')], { alt: 'A field of poppies' }));

    expect((await rows()).map((row) => row.alt_text)).toEqual([null, null]);
  });

  it('still honours alt on a single-file upload, which is the picker', async () => {
    await uploadPost(upload([png('only.png')], { alt: 'A field of poppies' }));

    expect((await rows())[0]!.alt_text).toBe('A field of poppies');
  });

  it('keeps the good files when one is too big', async () => {
    // A browser cannot reselect a partial file list, so sinking the batch would cost the editor
    // every other file as well — they would have to redo all of it.
    const oversized = png('huge.png', 4, 4, 26 * 1024 * 1024);
    const response = await uploadPost(upload([png('a.png'), oversized, png('c.png')]));

    const stored = await rows();
    expect(stored.map((row) => row.filename)).toEqual(['a.png', 'c.png']);
    expect(location(response)).toContain('rejected=');
    expect(location(response)).toContain('huge.png');
  });

  it('refuses the whole request over the file-count cap', async () => {
    // A request-level cap has no valid subset, so keeping the first ten of eleven would be silent
    // truncation with somebody's files in it.
    const response = await uploadPost(upload(Array.from({ length: 11 }, (_, i) => png(`${i}.png`))));

    expect(location(response)).toContain('error=');
    expect(await rows()).toHaveLength(0);
  });

  it('answers a rejected single upload the way it did before batching', async () => {
    const response = await uploadPost(upload([png('huge.png', 4, 4, 26 * 1024 * 1024)]));

    expect(location(response)).toContain('error=');
    expect(await rows()).toHaveLength(0);
  });
});

describe('bulk describe', () => {
  async function seedThree() {
    await uploadPost(upload([png('a.png'), png('b.png'), png('c.png')]));
    return rows();
  }

  function describeForm(fields: Record<string, string>, ids: string[]) {
    return h.context({
      method: 'POST',
      url: '/api/taproot/media/describe',
      form: { ids: ids.join(','), ...fields },
      headers: { accept: 'text/html' },
    });
  }

  it('stores a typed description', async () => {
    const [a] = await seedThree();
    await describePost(describeForm({ [`alt-${a!.id}`]: 'A lecture hall' }, [a!.id]));

    const after = await rows();
    expect(after.find((row) => row.id === a!.id)!.alt_text).toBe('A lecture hall');
  });

  it('writes the empty string only for a ticked Decorative box', async () => {
    const [a] = await seedThree();
    await describePost(
      describeForm({ [`alt-${a!.id}`]: '', [`decorative-${a!.id}`]: 'on' }, [a!.id]),
    );

    // `''` is "somebody decided this carries no information", which is what a screen reader skips.
    expect((await rows()).find((row) => row.id === a!.id)!.alt_text).toBe('');
  });

  it('leaves a blank row null rather than marking it decorative', async () => {
    const all = await seedThree();
    const [a, b, c] = all;

    // The failure this exists to prevent: describe one of three and save, and the other two must
    // still be *open questions*. Read as decorative, they vanish from the report having been
    // "decided" by an editor who never looked at them.
    await describePost(
      describeForm(
        {
          [`alt-${a!.id}`]: 'A lecture hall',
          [`alt-${b!.id}`]: '',
          [`alt-${c!.id}`]: '',
        },
        [a!.id, b!.id, c!.id],
      ),
    );

    const after = await rows();
    expect(after.find((row) => row.id === a!.id)!.alt_text).toBe('A lecture hall');
    expect(after.find((row) => row.id === b!.id)!.alt_text).toBeNull();
    expect(after.find((row) => row.id === c!.id)!.alt_text).toBeNull();
  });

  it('lets a typed description win over a leftover Decorative tick', async () => {
    const [a] = await seedThree();
    await describePost(
      describeForm({ [`alt-${a!.id}`]: 'A lecture hall', [`decorative-${a!.id}`]: 'on' }, [a!.id]),
    );

    // Nobody types a description they did not mean; a tick can be left over from a row that
    // arrived already marked. The more specific statement wins.
    expect((await rows()).find((row) => row.id === a!.id)!.alt_text).toBe('A lecture hall');
  });

  it('clears a description back to null when the box is emptied', async () => {
    const [a] = await seedThree();
    await describePost(describeForm({ [`alt-${a!.id}`]: 'First try' }, [a!.id]));
    await describePost(describeForm({ [`alt-${a!.id}`]: '' }, [a!.id]));

    // Back to "nobody has said" rather than to decorative — emptying a box is not a decision that
    // the image carries no information.
    expect((await rows()).find((row) => row.id === a!.id)!.alt_text).toBeNull();
  });

  it('skips a row the form never carried', async () => {
    const all = await seedThree();
    const [a, b] = all;
    await describePost(describeForm({ [`alt-${a!.id}`]: 'A lecture hall' }, [a!.id, b!.id]));

    // `b` was in `ids` but its field is absent, which is a truncated post rather than somebody
    // clearing a description. Nulling it would be a write nobody asked for.
    expect((await rows()).find((row) => row.id === b!.id)!.alt_text).toBeNull();
  });

  it('purges, because alt text is content a page renders', async () => {
    const [a] = await seedThree();
    const context = describeForm({ [`alt-${a!.id}`]: 'A lecture hall' }, [a!.id]);
    await describePost(context);

    const invalidated = (context.locals as { taproot: { invalidated: Set<string> } }).taproot
      .invalidated;
    expect([...invalidated]).toContain(SITE_TAG);
  });

  it('answers 422 with no ids rather than writing nothing quietly', async () => {
    const response = await describePost(
      h.context({ method: 'POST', url: '/api/taproot/media/describe', form: { ids: '' } }),
    );

    expect(response.status).toBe(422);
    expect((await body(response)).error).toBeTruthy();
  });
});
