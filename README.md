# spotify-pane

A Spotify now-playing pane for zterm: album art, track, progress, play/pause,
next, previous, seek, shuffle, repeat and volume, sized to whatever pane you
put it in.

On macOS it controls the **Spotify app on your Mac** directly, with no developer
account and no sign-in. It should work with a free Spotify account too, though that
hasn't been tested. An optional Web API mode controls
any Spotify Connect device (your phone, a speaker) instead.

## Requirements

- **zterm** with `--url` web panes (the release after v0.9.50 or later; run `zterm update`).
- **Node 18+.** There are no npm dependencies.
- **macOS** with the Spotify desktop app, for the default local mode.
  On Linux, only Web API mode works for now (see below).

## Install

```sh
git clone https://github.com/johnmorrow/spotify-pane.git ~/.local/share/spotify-pane
mkdir -p ~/.local/bin
ln -sf ~/.local/share/spotify-pane/bin/spotify-pane ~/.local/bin/spotify-pane
```

Make sure `~/.local/bin` is on your `PATH`, or link into `/usr/local/bin` instead.
To update later, run `git -C ~/.local/share/spotify-pane pull && spotify-pane stop`.
The next `spotify-pane` starts the new version.

## Use

```sh
spotify-pane                 # split right of the current pane (35%)
spotify-pane split_down --ratio 0.2
spotify-pane new_tab
spotify-pane status | stop | logs
```

The first time, macOS asks whether the server (`node` or `osascript`) may control
Spotify. Click **OK**. If Spotify isn't running, the pane offers to open it.

Keys in the pane: `space`/`k` play/pause, `←`/`j` previous, `→`/`l` next,
`↑`/`↓` volume, `s` shuffle, `r` repeat. Click the album art to open the track
in Spotify.

The layout follows the pane's shape: stacked when tall, art beside the
controls when wide, and a single strip when the pane is very short.

## How it works

`bin/spotify-pane` starts `server.mjs` on `127.0.0.1:8888` and opens it as a zterm
`--url` web pane. The server serves `public/` and passes the pane's commands to
a backend:

| backend | controls | needs |
|---|---|---|
| `macos` (default on macOS) | the Spotify app on this Mac, through AppleScript | nothing but the one-time permission prompt |
| `webapi` (default elsewhere) | any Spotify Connect device | Premium and your own Spotify developer app |
| `mock` | a fake player | nothing (for UI work) |

On macOS the server runs as a launchd job, not as a child of your shell. macOS
treats the app a process was started from as responsible for that process's
Apple Events. zterm doesn't currently have the automation entitlement, so
Spotify's permission prompt would hang if the server ran inside a zterm pane.

Local mode has two limits. Spotify's AppleScript support has no
repeat-one-track mode, so repeat is just on or off. And it controls only this Mac,
not your other devices.

## Web API mode (optional)

Use it to control playback on other devices, or on Linux.

1. At <https://developer.spotify.com/dashboard>, create an app. Add the redirect URI
   `http://127.0.0.1:8888/callback`, tick **Web API**, and save.
2. Run `SPOTIFY_PANE_BACKEND=webapi spotify-pane`. Paste the Client ID into the pane,
   then click **Sign in with Spotify**. Sign-in opens in your browser, and the pane notices
   once you're connected.

Spotify's terms limit this mode. A development-mode app allows only a handful of
users (5 as of 2026), each added by email in the dashboard, and the app owner needs
Premium. Getting past that limit requires Spotify's approval, which a personal
project won't get. So every person registers their own app. Tokens are stored in
`~/.config/spotify-pane/tokens.json` (mode 600).

## Settings

| env var | default | |
|---|---|---|
| `SPOTIFY_PANE_BACKEND` | `macos` on macOS, else `webapi` | `macos`, `webapi` or `mock`. |
| `SPOTIFY_PANE_PORT` | `8888` | In Web API mode, the redirect URI must use the same port. |
| `SPOTIFY_PANE_HOME` | `~/.config/spotify-pane` | Config, tokens, log. |
| `SPOTIFY_CLIENT_ID` | (none) | Web API mode: overrides the saved client ID. |
| `SPOTIFY_PANE_MOCK` | (unset) | `1` is shorthand for `SPOTIFY_PANE_BACKEND=mock`. |
| `SPOTIFY_PANE_MOCK_NEED` | (unset) | Mock mode: show a screen instead (`setup`, `signin`, `launch`, `permission-pending`, `permission-denied`). |

The server reads these when it starts. After changing one, run `spotify-pane stop`.

## Troubleshooting

- **"Permission needed" stays up.** Look for the macOS dialog. If you clicked
  *Don't Allow*, open System Settings → Privacy & Security → Automation and allow
  `node`/`osascript` to control Spotify.
- **The pane won't open.** Run `spotify-pane status` and `spotify-pane logs`. If the log
  says the port is in use, set `SPOTIFY_PANE_PORT`.
- **Web API: "No active device".** Open Spotify somewhere, or pick a device from the pane's list.
- **Web API: `INVALID_CLIENT: Invalid redirect URI`.** The dashboard's redirect URI must
  match `http://127.0.0.1:<port>/callback` exactly. Spotify requires `127.0.0.1`, not `localhost`.

## Developing

```sh
SPOTIFY_PANE_MOCK=1 SPOTIFY_PANE_PORT=8899 bin/spotify-pane split_right
zterm perform read_console --target <pane>
zterm perform screenshot_pane /abs/shot.png --target <pane>
zterm perform reload_pane --target <pane>    # after editing public/
```

Restart the server (`spotify-pane stop`) after editing `server.mjs` or `backends/`.

## Security notes

The server binds to 127.0.0.1 only. It answers only requests addressed to
127.0.0.1, localhost or [::1], which blocks DNS-rebinding attacks. Requests that
change anything must carry an `X-Spotify-Pane` header, so another website
open in your browser can't control playback. The AppleScript backend passes
values as arguments, never as script text.

## License

MIT. See [LICENSE](LICENSE).
