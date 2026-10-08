# SpectraWeaver

Persistent terminals in the browser, for running many CLI coding agents on a dev server.

> Status: early prototype. Expect rough edges. The plan is in [DESIGN.md](DESIGN.md).

> [!WARNING]
> SpectraWeaver puts a shell in a web page: anyone who can sign in gets a shell on your server. By default it listens on 127.0.0.1 only. Listen on the network only inside a network you trust, with a strong password, and **never expose it to the internet**. See [SECURITY.md](SECURITY.md).

- **Sessions outlive everything but the machine.** Close the tab, lose the network, restart the web server: programs keep running on the server.
- **Same state everywhere.** Every browser, window and device sees the same terminals, tabs and banners.
- **Any CLI.** Claude Code, Codex, Gemini CLI, shells, editors: these are real terminals, rendered with xterm.js, the same engine as VS Code's terminal.
- **Tabs and banners.** Group terminals into named, coloured tabs, each with its own layout (a grid, or windows you arrange) and URL, and give each terminal a note saying what it is doing.
- **Never garbled by viewing.** A terminal's size changes only when you resize it yourself. Tiles, windows and zoom only scale the font, so opening a session on another screen never makes a program redraw or lose its scrollback.

## Quick start

These steps run on the dev server (Linux or macOS). You need [Bun](https://bun.sh) 1.3.5 or later: `curl -fsSL https://bun.sh/install | bash` installs it. If your home directory is small, install Bun on a bigger disk with `curl -fsSL https://bun.sh/install | BUN_INSTALL=/local/$USER/bun bash`, and clone there too.

**1. Install.**

```sh
git clone https://github.com/YangXu1990uiuc/spectraweaver
cd spectraweaver
bun install
bun run install-cli
```

`install-cli` puts the `spectraweaver` command in `~/.local/bin`. If that directory is not on your `PATH`, it prints the line to add to your shell's startup file.

**2. Keep state on a local disk,** if your home directory is small or on NFS. Do it before the first `up`; otherwise skip this step.

```sh
spectraweaver config state-dir /local/$USER/spectraweaver
```

Any directory on a local disk works, such as one under `/local`, `/scratch` or `/data`. Keep the path short, because it holds the daemon's Unix socket (at most about 100 characters). The setting is saved in your home directory, so every host that shares it uses the same path, each in its own subdirectory.

**3. Set a password.** You sign in with it from the browser. It needs at least 8 characters.

```sh
spectraweaver passwd
```

**4. Start it.** On a network you trust, such as your company's internal network, let it listen on the network so that your laptop can open it directly:

```sh
spectraweaver up --host 0.0.0.0 --allow-remote
```

`up` remembers these options, so afterwards plain `spectraweaver up` does the same. It warns that it listens over plain HTTP, then prints the address to open:

```text
server  started at http://devbox:7778
Bookmark http://devbox:7778/ and sign in with your password.
If the name does not resolve there, use http://10.1.2.3:7778/
```

On a shared server, every user gets their own port (the first free one from 7777) and keeps it.

To stay off the network, run plain `spectraweaver up` and reach it through SSH instead (see [Reaching it from your laptop](#reaching-it-from-your-laptop)).

**5. Open it on your laptop.** Open the address, sign in, and bookmark it. A normal browser tab keeps Ctrl+W, Ctrl+T and Ctrl+N for itself; for them to reach the terminal, open the page as an app window. On Windows, press Win+R and run:

```text
msedge --app=http://devbox:7778/
```

For a desktop shortcut, give the full path: `"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --app=http://devbox:7778/`. Chrome works the same way (`chrome --app=…`), as does `google-chrome --app=…` on Linux.

Closing the browser leaves everything running. After the server reboots, run `spectraweaver up` again. To update, see [Upgrading](#upgrading).

### Reaching it from your laptop

- **Listening on the network** (step 4) needs the least setup, but it is plain HTTP: anyone who can watch the network can read your password and your terminals. Use it only on a network you trust. Ctrl+C and Ctrl+V work, and so do copies made by programs (OSC 52) right after a key press or click, which covers Claude Code and Codex; a program copying on its own later is blocked by the browser, which allows that only on HTTPS or `localhost`.
- **An SSH tunnel** keeps the server on 127.0.0.1 (plain `spectraweaver up`). Use the port that `up` printed:
  - **VS Code Remote-SSH** forwards the port by itself while it is connected: open the link on your laptop as it is.
  - **Otherwise, run this on your laptop** and keep it running (Windows 10 and 11 include `ssh`; use PowerShell):
    ```sh
    ssh -N -L 7777:localhost:7777 your-dev-server
    ```
    To forward every time you connect, add `LocalForward 7777 localhost:7777` under the server's `Host` entry in `~/.ssh/config`.
  - Browsers treat `localhost` as a secure context, so every clipboard feature works through a tunnel.
- **Switching back** to localhost only: `spectraweaver down && spectraweaver up --host 127.0.0.1`.
- **Without a password,** `up` prints a sign-in link with a token instead; `spectraweaver token` prints it again.

## Using it

- **Tabs:** ＋ adds a tab. Double-click a tab to rename it; right-click to recolour it, open it in a new window, or delete it. Each tab has its own URL (`#t=…`) and its own layout. Drag a terminal by its ⠿ grip onto a tab to move it there. Deleting a tab moves its terminals to the neighbouring tab.
- **Layout:** the selector in the top bar. **Windows** (the default) makes every terminal a window: drag its header to move it, its edges or corners to resize it, click one to bring it to the front, as on a desktop. The arrangement is stored with the tab, so every browser shows it; a new terminal takes a free cell of the tab's grid. **Grid** is rows × columns of equal tiles, in matrix order ("2 × 3" is 2 rows of 3 terminals); choosing one tidies the windows into it.
- **New terminal:** the size (columns × rows) is pre-filled to fit one tile of the current grid at your usual text size. Edit the numbers, or type the text size in pixels you want and the numbers follow.
- **Resize:** in a grid, drag the terminal's right edge, bottom edge or corner inside its tile (double-click the corner to fill the tile; zoom out first for more columns than fit at this text size); in a windows layout, drag the window's edges or corners and the terminal resizes with it. Either way the text keeps its size, and the program is told the new size and redraws. For exact numbers, or to choose a text size in pixels (the terminal then takes the most cells that fit at that size), click the size in the tile's header. Every browser follows, since the size belongs to the terminal rather than to the view. Full-screen programs redraw cleanly; inline tools that reprint their output when the width changes (Codex, Gemini CLI) clear the screen and lose their scrollback.
- **Banner:** click the title area of a tile and type what the terminal is for (in a windows layout, a click that does not drag the window).
- **Text size:** Ctrl/Cmd + `=` / `-` / `0`, or Ctrl + mouse wheel. Below 100% only the font changes and the rest of the tile stays blank; 100% fills the tile. Pressing Ctrl + `=` at 100% makes the text larger still by giving the terminal fewer columns and rows (a resize: the program is told and redraws), so a terminal whose text has become too small is read again in a few presses.
- **Focus one terminal:** ⤢ on its tile. ↗ opens it in its own window.
- **Attention:** when a terminal rings the bell, its tile, its tab and the browser tab title are marked until you look at it.
- **Updating agents:** ⏸ Stop agents makes every Claude Code and Codex session exit, as with Ctrl+C pressed twice (a task in progress is interrupted), and remembers how to resume each. Update them, then press ▶ Resume agents: each starts again in its terminal on the same conversation, keeping flags such as `--dangerously-skip-permissions` and `--model`. A tile shows ⏸ while its agent waits.
- **Copy and paste** follow VS Code on each OS:
  - Windows: Ctrl+C copies when text is selected (otherwise it interrupts the program), and Ctrl+V pastes.
  - Linux: Ctrl+Shift+C and Ctrl+Shift+V.
  - macOS: Cmd+C and Cmd+V.
  - Programs that use the mouse, such as Claude Code and Codex, select text themselves and copy it with their own keys (shown as sent to the terminal), which works. To select in the terminal instead, hold Shift while dragging (Option on macOS).
- **Browser shortcuts:** a normal browser tab keeps Ctrl+W, Ctrl+T and Ctrl+N for itself, so they never reach the terminal. Open the page as an app window instead: launch the browser with `--app=URL` (Quick start, step 5), or, over an SSH tunnel, install the page as an app in Chrome or Edge.

## Shared servers, small or NFS home directories

Every user runs their own instance. The first `up` picks the first free port from 7777 and remembers it, so your bookmark keeps working; use `--port N` to choose one. Sign-in is required even on localhost, because other users on the machine can reach 127.0.0.1.

Only a few kilobytes live in your home directory (`~/.config/spectraweaver`: the token, the password hash and settings), shared by all your hosts, so one password works everywhere. Everything else is per host, in `~/.local/state/spectraweaver/<hostname>/` or under the directory set with `config state-dir` (Quick start, step 2), so several servers sharing an NFS home never step on each other. Moving state later requires stopping everything, which ends every session:

```sh
spectraweaver down --all
spectraweaver config state-dir /local/$USER/spectraweaver
spectraweaver up
```

SpectraWeaver uses no file locks and no SQLite, the usual sources of NFS trouble. It writes every file atomically (write, then rename) and warns when the state directory is on a network filesystem. `SPECTRAWEAVER_HOME=/path` relocates config and state together, if you prefer an environment variable.

## Commands

| Command | What it does |
|---|---|
| `spectraweaver up [--port N] [--allow-host NAME]` | Start the daemon and the server in the background; later runs remember the options. (`--host ADDR --allow-remote` listens beyond localhost; read [SECURITY.md](SECURITY.md) first.) |
| `spectraweaver down [--all]` | Stop the server. `--all` also stops the daemon, which ends every session. |
| `spectraweaver status` | Show what is running. |
| `spectraweaver passwd [--clear]` | Set (or remove) the password for signing in from the browser. |
| `spectraweaver token [--rotate]` | Print the login token and link; `--rotate` replaces the token and signs out every browser. |
| `spectraweaver new [--size 120x36] [--cwd DIR] [-- COMMAND]` | Create a session from the command line. |
| `spectraweaver resize ID COLSxROWS` | Change a session's size; the program is told and redraws. |
| `spectraweaver ls` | List sessions. |
| `spectraweaver config [state-dir PATH \| --reset]` | Show where config and state live, or move this host's state. |

`bun run install-cli [DIR]` installs the command as a small script in `~/.local/bin` (or `DIR`) that runs your checkout, so `git pull` updates it; run it again if you move the checkout. Without it, run `bun run dev <command>` inside the checkout.

## Upgrading

```sh
cd spectraweaver
git pull
bun install
spectraweaver down && spectraweaver up
```

Then reload the page. This restarts only the web server, which picks up the new UI and server code; sessions keep running. The daemon is replaced only by `spectraweaver down --all`, which ends every session, so do that when nothing important is running.

## How it works

A small daemon owns the terminals (PTYs) and keeps a headless copy of each screen, using the same xterm.js engine that runs in the browser. The web server is a separate process: it can restart or be upgraded without touching running programs. When a browser connects, it gets a snapshot of each screen and then the live output. See [DESIGN.md](DESIGN.md) for the reasoning and the roadmap.

## Development

```sh
bun test                 # unit and integration tests
bun run typecheck
bun run check-headers    # every source file needs the license header
SPECTRAWEAVER_DEV=1 bun run dev server --port 7788   # server in the foreground
```

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) for attribution requirements. Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md).
