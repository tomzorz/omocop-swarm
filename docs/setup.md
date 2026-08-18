# Setup

## 1. Register a Foursquare app

Go to [foursquare.com/developers/apps](https://foursquare.com/developers/apps) and create one.

The v2 check-in endpoints are part of what Foursquare now calls the Personalization APIs, which are in public beta and carry their own EULA. You may have to accept it before `/users/self/checkins` answers.

Two things matter on the app:

- **Redirect URI.** Set it to exactly `http://localhost:3535/callback`. Not `http://localhost`, not with a trailing slash. Foursquare matches it against what the sign-in request sends, and the sign-in request sends what the port is configured to be. If you want a different port, set `SWARM_AUTH_PORT` and register the matching URI.
- **Client id.** Copy it. There is no client secret involved: the flow used here is the implicit grant, which has none.

## 2. Configure

Copy `.env.example` to `.env` and fill in the client id:

```
FOURSQUARE_CLIENT_ID=your-client-id-here
```

That is the only required setting. Everything else has a default.

## 3. Sign in

```bash
npm run build
node dist/cli/index.js auth
```

It prints a URL. Open it, approve the app, and the browser tab tells you when the token has been saved. The server stops on its own; it also gives up after ten minutes if nothing happens.

### Why there is a local server at all

The implicit grant returns the token in the URL *fragment*: `http://localhost:3535/callback#access_token=...`. Browsers never send a fragment to a server, so a redirect handler receives nothing. This is why the usual instructions for this flow end with "copy the token out of the address bar".

The way around it is to serve a page at the redirect target whose JavaScript reads `location.hash` (the browser will hand it to script even though it never put it on the wire) and posts it back over localhost. A random `state` value goes out with the sign-in request and is checked on the way back, so nothing else on the machine can push a token of its choosing into your archive during the window.

If Foursquare stops echoing `state`, the token is still accepted and a warning is logged. A sign-in that refuses to complete would be worse than one that says it could not verify the round trip.

### If you would rather paste it yourself

The token also works from the environment:

```
FOURSQUARE_TOKEN=...
```

An environment variable wins over the stored file. Getting the token by hand means running the authorize URL yourself and reading the fragment out of the address bar:

```
https://foursquare.com/oauth2/authenticate?client_id=YOUR_ID&response_type=token&redirect_uri=http://localhost:3535/callback
```

## 4. Sync

```bash
node dist/cli/index.js sync
```

The first run backfills your whole history and can take a few minutes on a long one. It is safe to interrupt: the position is written after every page, and running `sync` again continues from there rather than starting over.

`sync-status` tells you where things stand at any point.

## MCP client configuration

```json
{
  "mcpServers": {
    "omocop-swarm": {
      "command": "node",
      "args": ["/absolute/path/to/omocop-swarm/dist/index.js"]
    }
  }
}
```

**There is deliberately no `env` block.** This is the setup mistake that costs people an afternoon on every MCP server: the server is launched by its client, not by a shell, so it does not inherit your environment and does not read `.env`. Putting the token in an MCP config would work, and would also mean a credential sitting in a file that gets shared, backed up and pasted into issue reports.

Instead, `omocop-swarm auth` writes the token to `token.json` inside the archive directory, and the server looks for it there. Sign in once from a terminal and the MCP server has what it needs.

If the archive is not in the default place, the server does need to be told, because that is where it looks for both the data and the token:

```json
"env": { "SWARM_DATA_DIR": "D:/wherever/you/put/it" }
```

## Settings

| Variable | Default | What it does |
|---|---|---|
| `FOURSQUARE_CLIENT_ID` | none | Your app's client id. Needed only by `auth`. |
| `FOURSQUARE_TOKEN` | none | A token supplied directly. Wins over the stored one. |
| `SWARM_DATA_DIR` | `~/.omocop-swarm` | Where the archive lives. |
| `SWARM_AUTH_PORT` | `3535` | Port for the sign-in server. The redirect URI follows it. |
| `SWARM_DAY_START_HOUR` | `0` | Hour a day starts at, 0 to 23. At 6, a 02:00 check-in belongs to the night before. |
| `SWARM_PAGE_SIZE` | `250` | Items per API request. 250 is the documented maximum. |
| `SWARM_API_VERSION` | `20250401` | The pinned `v=`. Change it deliberately, then re-run with `--reprobe`. |
| `SWARM_HIDE_UNAVAILABLE_TOOLS` | off | Hide `sync` from the MCP tool list when no token is configured. |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug`. Always to stderr. |

## When something goes wrong

**"No Foursquare token is configured"** — `sync` needs one; everything else does not. Run `auth`.

**"Foursquare rejected the token"** — v2 user tokens do not expire on a timer, but they are revoked if the app registration changes or you disconnect the app. Run `auth` again. Nothing in the archive is affected.

**The redirect goes somewhere unexpected** — the registered URI and `SWARM_AUTH_PORT` disagree. They have to match exactly.

**The index looks empty but you have synced** — the schema version changed and the index was recreated. Run `reindex`; it rebuilds from the raw files without touching the network.

**A sync stopped partway** — run it again. That is the designed behaviour, not a recovery procedure.
