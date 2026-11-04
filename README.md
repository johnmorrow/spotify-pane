# spotify-pane

A Spotify now-playing pane for zterm. It controls whichever Spotify Connect
device is playing (the desktop app, your phone, a speaker): play/pause, next,
previous, seek, shuffle, repeat, volume, and starting playback on a device when
nothing is playing. It does not play audio itself, because zterm's webview cannot
run Spotify's DRM-protected player.

## Requirements

- **zterm** with `--url` web panes (the release after v0.9.50 or later; run `zterm update`).
  On Linux, zterm needs an X11 window.
- **Node 18+** (for built-in `fetch`). There are no npm dependencies.
- **Spotify Premium.** Spotify only lets Premium accounts control playback.
- **Your own Spotify developer app** (free, takes two minutes; see Setup).
  Every person who installs this registers their own app. Spotify limits a new app to
  25 users, and you'd have to add each one by email in the dashboard, so sharing one
  client ID doesn't work well.

## How it works

`server.mjs` runs on `127.0.0.1:8888`. It signs in to Spotify with PKCE (no
client secret), keeps the tokens in `~/.config/spotify-pane/tokens.json`
(mode 600), calls the Web API for the page, and serves `public/`. The pane is a
zterm `--url` web pane on that server. zterm's `--web` panes allow requests only
to their own folder, so a `--web` page can't reach the Spotify API.

## Install

```sh
git clone https://github.com/johnmorrow/spotify-pane.git ~/.local/share/spotify-pane
mkdir -p ~/.local/bin
ln -sf ~/.local/share/spotify-pane/bin/spotify-pane ~/.local/bin/spotify-pane
```

Make sure `~/.local/bin` is on your `PATH`, or link into `/usr/local/bin` instead.
To update later, run `git -C ~/.local/share/spotify-pane pull && spotify-pane stop`.
The next `spotify-pane` starts the new version.

## Setup (once)

1. Run `spotify-pane`. The pane opens on a setup screen.
2. At <https://developer.spotify.com/dashboard>, create an app. Add the redirect URI
   `http://127.0.0.1:8888/callback`, tick **Web API**, and save.
3. Paste the app's Client ID into the pane, then click **Sign in with Spotify**. Sign-in
   opens in your browser. When it says you're connected, the pane picks it up within
   a couple of seconds.

If port 8888 is taken, set `SPOTIFY_PANE_PORT` (for example in your shell profile)
and register `http://127.0.0.1:<port>/callback` instead. Spotify requires `127.0.0.1`
in the redirect URI, not `localhost`.

## Use

```sh
spotify-pane                 # split right of the current pane (35%)
spotify-pane split_down --ratio 0.2
spotify-pane new_tab
spotify-pane status | stop | logs
```

Keys in the pane: `space`/`k` play/pause, `←`/`j` previous, `→`/`l` next,
`↑`/`↓` volume, `s` shuffle, `r` repeat. Click the album art to open the track
in Spotify.

The layout follows the pane's shape: stacked when tall, art beside the
controls when wide, and a single strip when the pane is very short.

## Settings

| env var | default | |
|---|---|---|
| `SPOTIFY_PANE_PORT` | `8888` | Change the redirect URI in the Spotify dashboard to match. |
| `SPOTIFY_PANE_HOME` | `~/.config/spotify-pane` | Config, tokens, log, pid. |
| `SPOTIFY_CLIENT_ID` | (none) | Overrides the client ID saved from the setup screen. |
| `SPOTIFY_PANE_MOCK` | (unset) | `1` fakes a player, for UI work without an account. |

## Developing

```sh
SPOTIFY_PANE_MOCK=1 SPOTIFY_PANE_PORT=8899 bin/spotify-pane split_right
zterm perform read_console --target <pane>
zterm perform screenshot_pane /abs/shot.png --target <pane>
zterm perform reload_pane --target <pane>    # after editing public/
```

Restart the server (`spotify-pane stop`) after editing `server.mjs`.

## Troubleshooting

- **The pane says "No active device".** Open Spotify on any device (or pick one from the
  pane's device list). Spotify only accepts commands when a device is active.
- **The pane won't open.** Run `spotify-pane status` and `spotify-pane logs`. If the log
  says the port is in use, see the port note above.
- **Sign-in fails with `INVALID_CLIENT: Invalid redirect URI`.** The redirect URI in the
  dashboard must match `http://127.0.0.1:8888/callback` exactly.
- **Sign out or switch accounts:** `rm ~/.config/spotify-pane/tokens.json`, then
  `spotify-pane stop`.

## Security notes

The server binds to 127.0.0.1 only. It answers only requests addressed to
127.0.0.1, localhost or [::1], which blocks DNS-rebinding attacks. Requests that
change anything must carry an `X-Spotify-Pane` header, so another website
open in your browser can't control playback.

## License

MIT. See [LICENSE](LICENSE).
