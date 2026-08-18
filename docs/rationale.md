# Why it is built this way

Notes on the decisions that were not obvious, kept so that changing one is a decision rather than an accident.

## The archive is JSONL; SQLite is a cache

The raw files hold verbatim API objects, one per line, and nothing ever edits or deletes a line. SQLite holds a parsed projection of the same data and can be thrown away at any time.

The alternative, one database with parsed columns, is simpler and was rejected for a specific reason: every parsing decision becomes permanent the moment it is the only copy. Suppose `timeZoneOffset` turns out to have meant something slightly different in 2011 check-ins. With raw JSONL, that is a fix plus a `reindex`. Without it, the information needed to apply the fix was discarded years ago, and Foursquare is under no obligation to still have it.

The same property pays for itself in smaller ways. The schema has no migrations, because a version bump recreates the tables and refills them. A corrupt database is an inconvenience rather than a loss. Fields nobody has modelled yet are on disk when they turn out to matter.

The cost is a duplicated copy of the JSON in the index and two write paths per page. Both are cheap; a decade of check-ins is tens of megabytes.

## The check-in normaliser is allowed to fail in exactly one way

`normaliseCheckin` throws only when `id` or `createdAt` is missing, and reads every other field defensively. A fifteen-year archive contains check-ins from before `sticker` existed, venues that have since been deleted and come back as a bare name, and fields that arrive as the wrong type.

The rule is that normalisation may never fail on a check-in it does not recognise. A field it misreads is fixable later by re-indexing, because the raw JSON was written first. A field it throws on is a sync that stops dead in 2013 and takes the rest of the decade with it.

## Timestamps are stored twice, and one of them is not a timestamp

Each row carries `created_at` (a real UTC instant) and `local_ts` (the wall clock where the check-in happened, encoded as seconds by adding the recorded offset and reading the result as UTC).

`timeZoneOffset` is the valuable half of what the API sends. It is the only record of what the clock on the wall said where you actually were, and because it was recorded at the time, historical DST is automatically right without consulting a timezone database. Rendering a 2014 check-in in Tokyo through the archive machine's current zone produces a time that never happened to anybody.

`local_ts` is only ever compared against other wall clocks. Nothing may hand it to something expecting an instant.

## A day does not have to start at midnight

`dayStartHour` moves the boundary. At 6, a 02:00 check-in falls inside the previous day's window, which is what somebody asking "where was I on Friday" means. The night out did not become a different day because a clock rolled over mid-drink.

It defaults to 0 because that is the least surprising behaviour for a tool somebody else might install, and it is a setting rather than a stored column so that changing your mind does not require a re-index.

## Undocumented parameters are probed, not assumed

The current reference for `/users/self/checkins` documents `oauth_token`, `v`, `limit` and `offset`. The older v2 reference also had `afterTimestamp`, `beforeTimestamp` and `sort=oldestfirst`. Those appear to still work.

"Appears to still work" is not something to build a sync loop on. So the first sync sends four requests, each constructed so that a working parameter and a silently ignored one produce different answers, and records the verdict in `state.json` against the API version it was probed under.

The trick each probe uses is that the default order is newest-first and cannot be inverted. An ignored filter therefore returns the newest check-in, and getting the newest back is the signature of a parameter that did nothing. The `afterTimestamp` probe uses one second past the newest check-in rather than its own timestamp, so an inclusive boundary and an exclusive one both give the same answer.

Every parameter has a fallback needing only `limit` and `offset`. A "no" anywhere costs efficiency, never correctness.

## Searchable text is stored twice

Every column somebody filters on (venue name, city, country, category) has a `_fold` twin holding a case-folded, accent-stripped copy, and `compileFilter` folds the search value to match.

SQLite's `LIKE` folds ASCII case and nothing else. In an archive full of Hungarian venue names that is not a nicety: `kulturalis` returned nothing at all while `Kulturális` returned every visit, and the difference is an accented keyboard nobody wants to reach for on a phone. `CAFÉ` and `café` were likewise two different strings.

Folding drops accents rather than preserving them, because the direction people need is typing less. Somebody who types `Kulturális` still gets the match; somebody who types `kulturalis` has no other way to get one.

The cost is real and accepted: folded, Swedish `å` and `a` are the same letter, and they are not. The alternative is a collation library for a search box over one person's check-ins.

A second copy rather than a function over the original, because a function in the `WHERE` clause cannot use an index. Neither can a `LIKE` with a leading wildcard, so at this scale the indexes on the fold columns earn their keep only for grouping and the distinct-value scans behind `find-filters`. That is stated in the schema rather than quietly implied.

## Two tools exist because of how questions are phrased

`last-visit` and `find-filters` answer things the other tools could already answer.

"When did I last go to a bubble tea place" is `list-checkins --category "bubble tea" --limit 1`, and reading the date off the first row. But the answer wanted is a sentence with a gap in it ("four days ago"), not a row, and getting there requires knowing the archive spells it `Bubble Tea Shop`.

That second part is what `find-filters` is for. Without it, anything driving these tools has to guess the exact stored spelling, and a guess one word off returns zero results that read exactly like "you have never been there". The difference between a query surface and a usable one is mostly this.

`list-venues` replaced `top-venues` for a related reason: "where do I go most" wants a ranking, "what places did I visit in Paris" wants an enumeration, and ranking the second by frequency buries the one-off museum under the hotel you slept in four times. One tool, a `--sort` flag, rather than two tools that are 90% the same query.

## Two tables that turned out to hold nothing

`checkin_categories` and `checkin_companions` are populated and almost never queried. Before building multi-category filtering on the first, it was worth counting: across every check-in in a real multi-year archive, each one carries exactly one category, because that is all v2's checkins response returns. The companions table had single-digit rows over the same period.

Both stay, because normalisation writes them for free and the raw JSON has the data anyway. Neither gets a feature. The general lesson is the cheap one: check what the data actually contains before designing for what the schema permits.

## Backfilling by offset is the one thing that can silently skip a check-in

Paging through a collection that grows at the top shifts every later offset by one when something arrives mid-run, and a row falls through the gap. This is the failure mode that produces an archive which looks complete and is not.

Three responses, in order of preference:

1. `sort=oldestfirst` walks from the far end, where nothing is being inserted. Offsets do not move.
2. A pinned `beforeTimestamp` freezes the window at the instant the backfill began.
3. Neither available: page by offset, say so in the output, and compare the local total against `response.checkins.count` at the end so a gap is visible and a re-run repairs it.

The third is worse than the other two and is still better than pretending. A silent skip is the outcome worth spending design effort to avoid.

## Writes happen in an order chosen for crashes

Per page: raw JSONL, then the index, then the state file.

A crash between the first and second leaves rows on disk the index has not seen, which `reindex` finds. A crash between the second and third makes the next run re-fetch one page, which upserts to the same values. There is no ordering that loses data, and the reverse (state first) loses a page on every crash.

State is written after every single page rather than at the end. A backfill of a long history is minutes of paging, and the process can die in the middle of it. Without a persisted position the next run starts from zero, which is not merely slow: it is why people stop running the thing.

An append that follows a torn line inserts a newline first. Without it the next check-in is glued to the fragment and lost from the raw files while still being in the index, which stays invisible until a `reindex` silently drops it. That one was found by a test.

## Read-only, and structurally so

Foursquare's v2 API can create, edit and delete check-ins. This does none of it, and the tool surface has a test asserting that `sync` is the only tool declaring `requires: 'api'`. Anything else growing a network path is a design change, not a detail, and the test makes it one.

The `requires` gate replaces the scope gate a permissions-based API would have. A Foursquare user token is all or nothing, so the useful distinction here is not what you are allowed to do but whether you need to reach the network at all. Fourteen of the fifteen tools do not, which is why the archive stays fully queryable on a machine that has never been signed in.

## The SQL escape hatch is protected by SQLite, not by a regex

`query-archive` opens a second connection in SQLite's read-only mode. A statement that tries to write is refused by the engine.

A keyword blocklist would have to stay correct forever against things like `DELETE ... RETURNING`, which returns rows and would pass a "must start with SELECT" check. A read-only file descriptor is a fact rather than a thing to maintain. There is a test that runs exactly that `DELETE ... RETURNING` and asserts the rows are still there.

## The token is redacted at the sink

`redact` runs inside the logger, so a caller cannot leak the token by forgetting to sanitise. Separately, `sanitizeUrl` runs before any URL goes into a thrown error, because errors do not pass through the logger.

A Foursquare user token has no distinctive shape of its own, so the patterns key off the names it travels under: the query parameter, the environment variable, the JSON field of the auth callback. It also does not expire on its own and has no refresh token behind it, which makes one leaked debug line a permanent handover of read access to somebody's location history.

## Photos are metadata only

Check-in photos are stored as their URL halves, dimensions and ids. The bytes are not downloaded.

This was a deliberate choice rather than an omission, and it is the decision most likely to be regretted: if Foursquare retires the image CDN, the URLs become epitaphs. Adding a `sync-photos` command later would fit the existing shape without disturbing anything, since the metadata needed to do it is already archived.

## The fake in the tests implements the endpoint's rules

`test/support/fake-foursquare.ts` holds a real collection and pages it the way the endpoint does: newest-first ordering that cannot be turned off, `limit` capped at 250, the `meta`/`response` envelope, mandatory `v` and `oauth_token`.

The sync's correctness rests on assumptions about paging, and a fake that answers whatever it is asked cannot test them. The off-by-one that drops a check-in at a page boundary only shows up against something that pages properly. Do not weaken it to make a test pass.

The undocumented parameters are switchable on it, because each combination is a supported configuration of the sync and therefore needs to be a configuration of the fake.
