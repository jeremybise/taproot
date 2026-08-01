---
title: The audit log
description: What is recorded, what is not, and why nothing can edit it.
---

**Settings → Audit log**. Administrators only, because it names people and what they did.

## What is recorded

Consequential actions:

- Content published, scheduled, archived, deleted
- Releases created, scheduled, published, blocked, and content staged into or out of them
- People added, roles changed, accounts deactivated
- Two-factor cleared for someone, sessions ended
- Content types and other structural changes

Each entry has when, who, what, which thing, and some detail.

## What is not

**Ordinary saves.** Every save already appends a [revision](/content/revisions/) with its author,
which is a finer record than a log entry could be. What revisions cannot answer is "who put this in
front of the public, and when" — asked afterwards, across many items, by somebody who was not
involved. Logging saves too would bury exactly that.

## Entries survive their subjects

Who did it and what it was called are copied into the entry when it is written, not looked up when
you read it.

So an entry reading "someone@example.edu deleted Admissions" still reads that way after both the page
and the account are gone. Looking them up instead would render two blanks precisely when the record
matters most.

## Nothing edits it

There is no edit, no delete, and no API offering either. A log that can be tidied by whoever it
embarrasses is not a log.

The only removal is retention: a sweep that drops everything older than a date. "Delete entries about
me" and "delete last Tuesday" are the two capabilities an audit log must not have, so neither exists.

## Reading it

Filter by action or by person. The action list is built from what has actually happened on this
site, so it never offers a filter that would return nothing.

Subjects that still exist are links. A deleted one is plain text, which is itself informative.
