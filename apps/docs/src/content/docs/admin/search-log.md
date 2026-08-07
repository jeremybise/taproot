---
title: The search report
description: What visitors searched for, what the site failed to answer, and why the numbers are shaped the way they are.
---

**Settings → Search**. Visible to everyone who can sign in, unlike the audit log — the person who
can act on "eleven people searched for transcripts and found nothing" is whoever writes the pages.

## The report that matters

The screen leads with **Found nothing**, which is the opposite of how most analytics tools order it.
Top searches tell you what is already working. The failures are the only part that names something
to do:

- A term nobody has written a page for.
- A page that exists under a name nobody would guess — visitors searching "transcripts" while the
  page is called "Academic Records".

Each row links to the admin's own content search for that term, so you can check the second case
before assuming the first.

**A term leaves this list the moment one search for it succeeds.** The judgement is on the *most
recent* search, not on the worst or the average — so publishing the page is enough, and the report
stops accusing you of something you have already fixed. It works the other way too: a term that
used to succeed and has started failing appears here, which is usually a page that was unpublished
or renamed.

## Most searched

The result count beside each term is **what the latest search for it found**, for the same reason.
It answers "does this work now" rather than averaging over a period somebody may have fixed it in.
A count of **None** is called out in words as well as position.

Spellings are grouped: `Nursing`, `nursing` and `NURSING` are one term, as are `Peña` and `pena` —
the report groups exactly the way search matches, so it never splits a term the search engine
treats as one. The spelling shown is the one most people used.

## The three kinds of search

| Source | What it means |
| --- | --- |
| Submitted | Somebody typed a term and pressed Search or Enter |
| Suggestion | Somebody picked a result from a type-ahead list |
| Abandoned | Somebody typed into a search box, saw the suggestions, and gave up |

**Abandoned searches are off by default**, and the checkbox says why: what gets recorded is whatever
the visitor had reached when they stopped, so it may be half a word. Mixed into a leaderboard they
produce advice like "write a page about nursi". Turn them on when you are hunting for gaps — they
are the only way to see the visitor who typed into the header, saw nothing, and never pressed
anything.

Which of the three your site reports depends on how it was built. A site with no type-ahead only
ever records submitted searches.

## What is not recorded

No addresses, no accounts, no sessions, no device information. A row is a term, a result count, a
source and a time, and nothing ties two rows to the same person.

That is deliberate rather than incidental. A search log at a college contains "withdrawal
deadline", "counseling", "financial aid appeal" — anything that let a row be traced back to a person
would turn a content report into a record of who was worried about what.

The consequence is that the report cannot answer "how many people searched", only "how many
searches happened", and there is no way to follow one visitor's session. That is the right trade.

## If the report is empty

A site reports its own searches; the CMS does not observe them. Two things have to be true:

1. The site calls the CMS after each search — see **Building a site → The client**.
2. The API key it uses has the **`search:write`** scope. `content:read` alone is not enough, and a
   key created before this feature existed will not have it. Settings → API keys is where to check.

An empty report with a working search box is nearly always the second one.

## Keeping it

Nothing deletes old rows automatically. The capability exists for an operator to sweep by age, the
same way the audit log's does, but no schedule runs it — a CMS should not quietly start deleting a
deployment's data. Ask your operator if the log needs bounding.
