# workstreams

Persistent terminals in the browser, for running many CLI coding agents on a dev server.

> Status: early prototype. Expect rough edges. The plan is in [DESIGN.md](DESIGN.md).

- **Sessions outlive everything but the machine.** Close the tab, lose the network, restart the web server: programs keep running on the server.
- **Same state everywhere.** Every browser, window and device sees the same terminals, tabs and banners.
- **Any CLI.** Claude Code, Codex, Gemini CLI, shells, editors: these are real terminals, rendered with xterm.js, the same engine as VS Code's terminal.
- **Tabs and banners.** Group terminals into named, coloured tabs, each with its own grid and URL, and give each terminal a note saying what it is doing.
- **Never garbled by viewing.** A terminal's size is fixed when you create it. Tiles, windows and zoom only scale the font, so opening a session on another screen never makes a program redraw or lose its scrollback.

## Quick start

Requires [Bun](https://bun.sh) 1.3.5 or later, on Linux or macOS.

```sh
git clone https://github.com/YangXu1990uiuc/workstreams
cd workstreams
bun install
bun run dev up
```

`up` starts the daemon and the web server in the background and prints a login link like `http://127.0.0.1:7777/#token=…`.

The server only listens on 127.0.0.1. To reach it from your laptop, forward the port and open the link there:

```sh
ssh -L 7777:localhost:7777 your-dev-server
```

VS Code Remote's port forwarding works too. Browsers treat `localhost` as a secure context, so clipboard features work over the tunnel.

**Sign in with a password instead of the link:** run `bun run dev passwd` (or use ⚙ Settings in the page), then bookmark `http://127.0.0.1:7777/`. The login page shows whose instance it is (`user @ host`) and asks for the password.

## Using it

- **Tabs:** ＋ adds a tab. Double-click a tab to rename it; right-click to recolour it, open it in a new window, or delete it. Each tab has its own URL (`#t=…`) and its own grid. Drag a terminal by its ⠿ grip onto a tab to move it there. Deleting a tab moves its terminals to the neighbouring tab.
- **Grid:** rows × columns, in matrix order: "2 × 3" is 2 rows of 3 terminals.
- **New terminal:** the size (columns × rows) is pre-filled to fit one tile of the current grid at your usual text size. Edit the numbers if you like; the size cannot change later.
- **Banner:** click the title area of a tile and type what the terminal is for.
- **Zoom a tile:** Ctrl/Cmd + `=` / `-` / `0`, or Ctrl + mouse wheel. Zoom only changes the font; 100% fills the tile.
- **Focus one terminal:** ⤢ on its tile. ↗ opens it in its own window.
- **Attention:** when a terminal rings the bell, its tile, its tab and the browser tab title are marked until you look at it.
- **Copy and paste** follow VS Code on each OS:
  - Windows: Ctrl+C copies when text is selected (otherwise it interrupts the program), and Ctrl+V pastes.
  - Linux: Ctrl+Shift+C and Ctrl+Shift+V.
  - macOS: Cmd+C and Cmd+V.
- **Browser shortcuts:** open the page as an app window (install it as an app in Chrome/Edge, or launch with `--app=URL`). A normal browser tab keeps Ctrl+W, Ctrl+T and Ctrl+N for itself, so they never reach the terminal.

## Shared servers

Every user runs their own instance; state lives in each user's home directory. The first `up` picks the first free port from 7777 and remembers it, so your bookmark keeps working. Use `--port N` to choose one. Sign-in is required even on localhost, because other users on the machine can reach 127.0.0.1.

## Commands

| Command | What it does |
|---|---|
| `workstreams up [--port N] [--host ADDR] [--allow-host NAME]` | Start the daemon and the server in the background. |
| `workstreams down [--all]` | Stop the server. `--all` also stops the daemon, which ends every session. |
| `workstreams status` | Show what is running. |
| `workstreams passwd [--clear]` | Set (or remove) the password for signing in from the browser. |
| `workstreams token [--rotate]` | Print the login token and link; `--rotate` replaces the token and signs out every browser. |
| `workstreams new [--size 120x36] [--cwd DIR] [-- COMMAND]` | Create a session from the command line. |
| `workstreams ls` | List sessions. |

When running from source, use `bun run dev <command>`.

## Upgrading

Restarting the web server (`down`, then `up`) is safe and picks up new UI and server code; sessions keep running. The daemon is only replaced by `down --all`, which ends every session, so do that when nothing important is running.

## How it works

A small daemon owns the terminals (PTYs) and keeps a headless copy of each screen, using the same xterm.js engine that runs in the browser. The web server is a separate process: it can restart or be upgraded without touching running programs. When a browser connects, it gets a snapshot of each screen and then the live output. See [DESIGN.md](DESIGN.md) for the reasoning and the roadmap.

## Development

```sh
bun test                 # unit and integration tests
bun run typecheck
bun run check-headers    # every source file needs the license header
WORKSTREAMS_DEV=1 bun run dev server --port 7788   # server in the foreground
```

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) for attribution requirements.
