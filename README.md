# omocop-swarm

Pulls your Foursquare/Swarm check-in history onto your own disk, keeps it current, and lets you ask it things. Works as an MCP server and as a command-line tool, over the same code.

Fifteen years of "where was I" lives in someone else's database. This copies it to yours.

## What it does

`omocop-swarm sync` walks `/users/self/checkins` and writes every check-in to a local archive. Re-run it whenever; it fetches only what is new. Kill it halfway through the first backfill and it picks up where it stopped, because it saves its position after every page.

After that, everything is local:

```bash
omocop-swarm last-visit --category "bubble tea"        # when did I last go to one of those
omocop-swarm list-venues --city paris --sort recent     # what places did I visit in Paris
omocop-swarm find-filters --query bubble                # what is this actually called in here
omocop-swarm list-checkins --from 2019-06-12            # where was I that day
omocop-swarm list-checkins --from 2019-06-01 --to 2019-06-30 --city Berlin
omocop-swarm search-checkins --query "langos"           # full-text, including your own shouts
omocop-swarm checkin-stats --country HU                 # totals, plus weekday and hour histograms
omocop-swarm checkins-near --lat 47.4979 --lng 19.0602 --radius 800
omocop-swarm query-archive --sql "SELECT ..."           # for whatever nobody thought of
```

Every one of those reads local files. None of them contacts Foursquare, none needs a token, and they all work on a plane.

## Read-only, on purpose

This never writes to Foursquare. It does not check you in, edit a check-in, or delete one. `sync` is the only command that opens a socket, and all it does is GET. The one exception is `check-auth-status --verify`, which you have to ask for: it sends a single GET to confirm Foursquare still accepts the token.

## How the archive is stored

Two layers, under `~/.omocop-swarm` by default:

```
raw/checkins-2019-06.jsonl    the archive: verbatim API objects, one per line, append-only
index.sqlite                  a projection of the above, rebuildable at any time
state.json                    sync watermarks and what the API turned out to support
token.json                    written by `omocop-swarm auth`
```

The JSONL files are the real thing. Nothing edits or removes a line once it is written, and the check-in is stored exactly as the API sent it, including fields this codebase does not know about. If a future version parses something differently, `omocop-swarm reindex` applies the change to your whole history without touching the network.

The SQLite index is a cache with a schema version on it. Corrupt it, delete it, or upgrade past it, and `reindex` puts it back.

## Setup

You need a Foursquare app of your own. There is no shared key and no personal access token; the v2 user endpoints take an OAuth token that belongs to you.

1. Register an app at [foursquare.com/developers/apps](https://foursquare.com/developers/apps). The check-in endpoints sit under the Personalization APIs, so you may have to accept that EULA.
2. Set the app's redirect URI to exactly `http://localhost:3535/callback`.
3. Put the client id in `.env` next to the project: `FOURSQUARE_CLIENT_ID=...`
4. Run `omocop-swarm auth` and open the URL it prints.
5. Run `omocop-swarm sync`.

Step 4 needs the local server because of how the implicit flow works: the token comes back in the URL fragment, and a fragment is never sent to a server. The page served at the redirect reads it with JavaScript and posts it back over localhost. That is why the redirect URI has to match to the character.

Full details, including MCP client configuration, are in [docs/setup.md](docs/setup.md).

## As an MCP server

```json
{
  "mcpServers": {
    "omocop-swarm": {
      "command": "node",
      "args": ["/path/to/omocop-swarm/dist/index.js"]
    }
  }
}
```

No `env` block needed. An MCP server is launched by its client rather than by a shell, so it never sees your environment or your `.env`, which is exactly why `auth` writes the token into the archive directory instead. The server looks for it there.

Seventeen tools are registered. Sixteen read the archive and work with no token at all; `sync` is the one that needs one, and it says so plainly if it is missing rather than failing somewhere obscure.

## The undocumented bit

The current reference for `/users/self/checkins` documents four parameters: `oauth_token`, `v`, `limit` (250 max) and `offset`. The older v2 reference also had `afterTimestamp`, `beforeTimestamp` and `sort`, and those appear to still work, but "appears to still work" is a bad foundation for a sync loop.

So the first sync probes them. Four requests, each constructed so that a working parameter and an ignored one give different answers, and the verdict goes in `state.json`. Every one of them has a fallback that needs nothing but `limit` and `offset`. `sync-status` shows what was found.

This matters most for the backfill. Paging by offset through a collection that can grow at the top will skip a row if a check-in arrives mid-run. `sort=oldestfirst` or a pinned `beforeTimestamp` holds the window still; with neither, the sync says so in its output and compares the totals at the end so you know to re-run.

## CLI

Installing the package also installs an `omocop-swarm` binary. Every tool the MCP server registers is a subcommand, and every input field is a flag, derived from the same schema, so the two surfaces cannot drift apart:

```bash
omocop-swarm --help                          # every subcommand, grouped by area
omocop-swarm last-visit --help               # one subcommand's flags
omocop-swarm recent-checkins --limit 5 --format json
```

Output is text by default, the same prose an MCP client sees. `--format json` prints the structured result the MCP tool returns, and `--json` is shorthand for it. Errors go to stderr in either format, and the exit code says what happened: 0 for success, 1 for a tool error, 2 for a usage mistake. A script should check the exit code rather than parse stdout. `omocop-swarm auth` starts the sign-in server; `authenticate` has no subcommand, because it only exists to hand an MCP model sign-in instructions. Validation, the token requirement and error handling run through the same code path as the MCP server, so the CLI is a second door into the same house. Unlike the MCP server, it runs in your shell, so it also reads `.env` from the working directory (a real environment variable wins).

For a coding agent the CLI is usually the better door: nothing has to be running, output can be trimmed before it reaches the context, and the query subcommands are easy to allow one at a time in a permission list.

Most query commands share the same filters: `--from`, `--to`, `--venue`, `--category`, `--city`, `--country`, `--with-photos`, `--with-shout`, `--with-friends`.

Matching ignores case **and accents**, so `--venue kulturalis` finds `Koreai Kulturális Központ`. You never have to reach for the accented keyboard to search your own history. If you are not sure what something is called in the archive, `find-filters` takes a fragment and hands back the exact values the other commands want.

`--day-start 6` moves the boundary of a day off midnight, so a 02:00 check-in counts towards the night before. Set `SWARM_DAY_START_HOUR=6` to make that the default.

## Photos

The archive stores photo metadata and URLs, not the images. `get-checkin` reassembles the full-size URL for each one. If you want the bytes, that is a feature this does not have.

## Development

```bash
npm install
npm run verify     # lint, typecheck, tests, and a stdio smoke test against a real process
```

`npm run verify` is the bar for every change. The test suite runs against a fake `/users/self/checkins` that implements the endpoint's real rules (newest-first ordering it cannot be told to abandon, `limit` capped at 250, the `meta`/`response` envelope), because the paging logic is the part most likely to be subtly wrong, and a fake that answers whatever it is asked cannot catch that.

## Licence

MIT.
