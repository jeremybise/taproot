---
title: API keys
description: How another site reads this one's content, and why a key is never a person.
---

An **API key** lets another deployment read this site's published content over HTTP, through the
delivery API.

**Settings → API keys.** Administrators only, in both directions: creating one hands out read access
to everything published, and the list is an inventory of which integrations exist.

## A key is not a person

It has **scopes**, not a role. It cannot edit anything, cannot own content, and never appears as the
author of a change. Nothing a key does is attributed to a user, and nothing written as "an editor
did this" is ever satisfied by one.

That separation is deliberate. Modelling a key as a user with a role would make every permission
check in Taproot silently answer for it.

## Creating one

Give it a **label** naming the thing that will hold it — "campus website", "staging" — so you know
what breaks if you revoke it.

**Expiry is optional and blank is the safer default.** A key that lapses on its own takes a website
down at a moment nobody chose.

There are two scopes. `content:read` reads published content through the delivery API — drafts are
never included, whatever the key holds. `search:write` lets a site report what visitors searched for,
and admits appending one row to that log and nothing else: it cannot read the log back and carries no
access to content. A site that does not report searches should not be given it.

A key created before `search:write` existed does not have it. An empty search report beside a working
search box is nearly always that.

## The key is shown exactly once

Copy it when it appears. Taproot stores only a hash, so there is nothing to look it up from — if you
lose it, revoke that key and create another.

It is handed back through a one-time reveal rather than the address bar, because a URL lands in
browser history, in the `Referer` header, and in every access log along the way. That is a poor
place for a live credential.

Store it wherever the consuming deployment keeps its secrets. Do not commit it.

## Identifying a key later

Each row shows the first characters of its token — `tpr_a1b2c3d4…` — which is enough to match a row
against the value in some deployment's configuration and nowhere near enough to use.

## Before you revoke one

The list shows when each key was **last used**, which is the question this screen is usually opened
to answer. It is recorded to the minute rather than the second, deliberately: sharpening it would
mean a database write on every read the delivery API serves.

A key that says "never used" after a while genuinely is not in use.

## Revoking

Type the key's visible prefix to confirm. It is checked on the server.

Revocation is immediate — anything holding that key stops working at once.

**Revoked keys are kept, not deleted.** The audit log records that a key was created and by whom,
and entries name it; deleting the row would leave those pointing at something nothing can resolve.
Same reasoning as deactivating a person rather than removing them.

## What a key cannot do

Reach the admin API. Those endpoints require a signed-in person, and a key has no session — so a
`content:read` credential that leaks cannot be used to edit, publish, or delete anything. It can
read what any visitor to the published site could already read.

## Generating types for a consumer

A site reading Taproot can generate TypeScript for **your** content types, rather than working with
untyped blobs:

```bash
TAPROOT_API_URL=https://cms.example.edu TAPROOT_API_KEY=tpr_… npm run taproot:types
```

That reads the live content model over the same delivery API a consumer uses, and writes a
`content.d.ts` the site checks in. The moment somebody renames a field, the templates that used it
stop compiling — which is the point.

