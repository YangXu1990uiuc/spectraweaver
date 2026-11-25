# SpectraWeaver

Persistent terminals in the browser, for running many CLI coding agents on a dev server.

> Status: early prototype. Expect rough edges. The plan is in [DESIGN.md](DESIGN.md).

> [!WARNING]
> SpectraWeaver puts a shell in a web page: anyone who can sign in gets a shell on your server. By default it listens on 127.0.0.1 only. Listen on the network only inside a network you trust, with a strong password, and **never expose it to the internet**. See [SECURITY.md](SECURITY.md).

- **Sessions outlive everything but the machine.** Close the tab, lose the network, restart the web server: programs keep running on the server.
- **Same state everywhere.** Every browser, window and device sees the same terminals, tabs and banners.
- **Any CLI.** Claude Code, Codex, Gemini CLI, shells, editors: these are real terminals, rendered with xterm.js, the same engine as VS Code's terminal.
- **Tabs and banners.** Group terminals into named, coloured tabs, each with its own arrangement of windows and its own URL, and give each terminal a note saying what it is doing.
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

Then have it start again whenever the server reboots:

```sh
spectraweaver autostart on
```

This adds one `@reboot` line to your crontab on this host (your other crontab lines stay as they are; `spectraweaver autostart off` removes it). At boot, cron runs `spectraweaver up` in your login shell, so terminals get the same `PATH` as when you sign in, and it keeps trying for 5 minutes if your home directory or the network comes up late. Its output goes to `autostart.log` in the state directory.

**5. Open it on your laptop.** Open the address, sign in, and bookmark it. A normal browser tab keeps Ctrl+W, Ctrl+T and Ctrl+N for itself; for them to reach the terminal, open the page as an app window. On Windows, press Win+R and run:

```text
msedge --app=http://devbox:7778/
```

For a desktop shortcut, give the full path: `"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --app=http://devbox:7778/`. Chrome works the same way (`chrome --app=…`), as does `google-chrome --app=…` on Linux.

Closing the browser leaves everything running. After the server reboots, SpectraWeaver starts again by itself (with `autostart on`; otherwise run `spectraweaver up`); press **↻ Restore** to bring your terminals back (see [Using it](#using-it)). To update, see [Upgrading](#upgrading).

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

- **Tabs:** ＋ adds a tab. Double-click a tab to rename it; right-click to recolour it, open it in a new window, or delete it. Each tab has its own URL (`#t=…`) and its own arrangement of windows. Drag a terminal by its ⠿ grip onto a tab to move it there. Deleting a tab moves its terminals to the neighbouring tab.
- **Windows:** every terminal is a window: drag its header to move it, its edges or corners to resize it, click one to bring it to the front, as on a desktop. The arrangement is stored with the tab, so every browser shows it. A new terminal takes the first free quarter of the screen (the tab's 2 × 2 grid), else cascades. Tick **Snap to grid** in the top bar to make windows land on grid lines (36ths of the workspace, so halves, thirds and quarters line up); hold Alt while dragging to do the opposite. **×** closes a terminal, after asking; in a tab with a task board, **×** only puts the window away (see below).
- **New terminal:** **+ New terminal** opens one at once in a free spot, sized to fill its window at your usual text size, in the directory of the terminal you used last. **▾** beside it opens a dialog for a working directory, a startup command (such as `claude`) or an exact size; its size fields start from the same recommendation, and typing a text size in pixels sets the numbers.
- **Resize:** drag a window's edges or corners and the terminal resizes with it, keeping its text size; the program is told the new size and redraws. For exact numbers, or to choose a text size in pixels (the terminal then takes the most cells that fit at that size), click the size in the tile's header. Every browser follows, since the size belongs to the terminal rather than to the view. Full-screen programs redraw cleanly; inline tools that reprint their output when the width changes (Codex, Gemini CLI) clear the screen and lose their scrollback.
- **Banner:** click the title area of a tile and type what the terminal is for (a click that does not drag the window).
- **Text size:** Ctrl/Cmd + `=` / `-` / `0`, or Ctrl + mouse wheel. Below 100% only the font changes and the rest of the tile stays blank; 100% fills the tile. Pressing Ctrl + `=` at 100% makes the text larger still by giving the terminal fewer columns and rows (a resize: the program is told and redraws), so a terminal whose text has become too small is read again in a few presses.
- **Focus one terminal:** ⤢ on its tile. ↗ opens it in its own window.
- **Attention:** when a terminal rings the bell, its tile, its tab and the browser tab title are marked until you look at it.
- **What each agent is doing:** a terminal running Claude Code or Codex shows it in its header: **working** (blue), **idle** at its prompt, **needs approval** or **needs you** (amber: a permission prompt, a question, a dialog), or **⚠** and why it stopped (red: `at capacity`, `usage limit`, `rate limited`, `safety block`, `context full`, `connection failed`, `login needed`, `API error`). A red or amber terminal also marks its tab. The state comes from the agents' own files where they record it (Claude Code's session registry and transcript, Codex's rollout) and from the bottom of the screen where they do not (Codex's approval prompts and its cyber warning); hover over the badge for the agent's own words. Recognising approval prompts and screen text needs a daemon started by this version (`spectraweaver down --all`, `up`, then **↻ Restore**).
- **From the command line, or from an agent:** `spectraweaver ls`, `new`, `read`, `send`, `wait`, `banner`, `show`, `hide` and `close` (see Commands) let a script or a coordinating agent open terminals, see what each one's agent is doing (and its model, what a dialog asks, when a usage limit lifts), read its screen or just its latest reply, and answer it, as you would in the browser. A terminal opened from a terminal lands in the same tab. `spectraweaver ls --json` gives everything, with each terminal's agent state; `SPECTRAWEAVER_SESSION_ID` tells a program which terminal it runs in.
- **Files and screenshots:** drop files on a terminal's window, or paste a screenshot into it (Ctrl+V on Windows, Ctrl+Shift+V on Linux, ⌘V on macOS), and they are uploaded to the machine the terminal runs on (`/tmp/spectraweaver-<uid>/uploads`, private to you, kept a week, up to 25 MB each); their paths are typed into the terminal, so an agent can look at them.
- **Task board:** one agent can coordinate others. Start it in a terminal of a tab and tell it, in your own words, how to split and track the work, adding *"Use spectraweaver to run worker terminals and keep this tab's task board; run `spectraweaver board --help` first."* It opens a terminal per worker and keeps pushing a small JSON of tasks with `spectraweaver board set`. The board is a window in the tab: the tasks and what each waits for as a graph, coloured by the status the agent gave them (grey to do, blue in progress, green done, red blocked), and on each task the live state of the terminal working on it. Red and amber rings mark what needs someone: an agent that stopped or waits, or a task in progress whose terminal is gone or idle at its shell. The first board puts itself on the left and the agent on the right; its workers start put away. A worker's window is named by its task, from the board (`T28 Small model trainer`), so there is no banner to keep up; the agent's own window says `lead · <board title>`. Click a task for its details; double-click it to open its terminal over the board, look or step in, and put it away again with **×**: in this tab **×** never ends a program. To end one, right-click its task (or its window's header) and choose **Terminate…**. The board and the agent's window have no **×**; resize them to make room. Terminals put away that no task names are listed on the board (“+1 off the board”). Drag the board's background to pan; Ctrl + wheel (or Ctrl + `=` / `-`) zooms and Ctrl + `0` fits it to the window again. The graph runs whichever way fits the window better, or the way you set with the ↓ / → button. **Show board** in a tab's menu opens an empty board that explains how to start. SpectraWeaver only shows the board: how the work is split, tracked (a repository, files) and coordinated is up to your prompt.
- **Restore after a reboot:** a reboot, or `spectraweaver down --all`, ends every terminal. SpectraWeaver keeps note of each one while it runs (tab, window, size, directory, and the Claude Code or Codex conversation in it), so afterwards **↻ Restore N** in the top bar opens them again where they were, each agent resuming the same conversation with flags such as `--dangerously-skip-permissions` and `--model`. An agent comes back at its prompt; tell it to continue. A plain shell comes back in its directory; whatever ran in it does not restart. **Forget** drops the ones you no longer need.
- **Resume a recent conversation:** **↻ Restore** also lists the Claude Code and Codex conversations of the last two weeks that no terminal is on, read from the agents' own files; tick some and **Open** them in new terminals.
- **Updating Claude Code or Codex:** `spectraweaver down --all`, update them, `spectraweaver up`, then **↻ Restore**.
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
| `spectraweaver status` | Show what is running, and whether it starts at boot. |
| `spectraweaver autostart [on \| off]` | Start SpectraWeaver when this host boots (a crontab `@reboot` line), or stop doing so. |
| `spectraweaver passwd [--clear]` | Set (or remove) the password for signing in from the browser. |
| `spectraweaver token [--rotate]` | Print the login token and link; `--rotate` replaces the token and signs out every browser. |
| `spectraweaver config` / `config state-dir PATH \| --reset` | Show where config and state live, or move this host's state. |
| `spectraweaver ls [--json] [--tab NAME \| --all]` | List terminals (run in a SpectraWeaver terminal: those of its own tab, unless `--tab` or `--all`): tab, banner, and what each one's coding agent is doing (working, idle, waiting for an answer, or stopped and why) and its model; `--json` adds what a waiting agent's dialog asks (`detail`) and when a usage limit lifts (`resetsAt`). |
| `spectraweaver new [--tab NAME] [--banner TEXT] [--size 160x48] [--cwd DIR] [--show] [-- COMMAND]` | Create a terminal (160 × 48 unless `--size`: large, so `read` shows more) and print its id; `COMMAND` is typed into its shell. It lands in the tab of the terminal the command runs in, else the first tab; a tab name no tab has yet makes a new tab. In a tab with a board it starts put away, unless `--show`. |
| `spectraweaver read ID [--lines N \| --reply]` | Print a terminal's screen as text; `--lines N` prints its last N lines, scrollback included; `--reply` prints only its agent's latest reply, from the agent's conversation. |
| `spectraweaver send ID TEXT… [--no-enter]` | Type text into a terminal and press Enter. `-` reads it from standard input; several lines go in as one paste. It lands in the terminal's input box, in the middle of anything a person is typing there, so agents should pass results through files and keep `send` for handing out tasks and waking a stopped agent. |
| `spectraweaver send ID --key NAME…` | Press keys: `enter`, `esc`, `tab`, `shift-tab`, arrows (`up`…), `backspace`, `ctrl-c`, `ctrl-d`, or a single character such as `1`. |
| `spectraweaver wait [ID…] [--board] [--until STATES] [--all] [--changed] [--timeout 30m]` | Wait until one of the terminals stops working (idle, waiting, stopped, exited, or `lifted`: a usage limit that has; `--all`: all of them) and print it. `--board`: also until a task of the board changes (not by this terminal), printing what changed and from which terminal. `--changed` counts only a state entered after the wait began, as after a `send`. After `--timeout` (30 minutes unless given; `none` waits for ever) it returns anyway, exit status 124, listing how long each has been doing what it does: time to look in, as a job that hangs keeps its terminal working. |
| `spectraweaver banner ID TEXT` | Set a terminal's banner. A terminal a task on a board names is called by that task instead (its window shows the task's id and title), until no task names it. |
| `spectraweaver resize ID COLSxROWS` | Change a terminal's size; the program is told and redraws. |
| `spectraweaver show ID` / `hide ID` | Bring a terminal's window out, in front; or put it away (only in a tab with a board, which brings it back). |
| `spectraweaver close ID` | Close a terminal, ending its program. |
| `spectraweaver board set [FILE \| -] [--tab NAME]` | Set a tab's task board from JSON (`spectraweaver board --help` gives the format); without `--tab`, the board of the tab the command runs in. |
| `spectraweaver board update ID [--status S] [--note TEXT] [--title TEXT] [--after IDS] [--session ID] [--link URL]` | Change one task of the board (or add it, given `--status`); `""` removes a field. A worker can mark its own task. |
| `spectraweaver board show [--since 30m] \| clear [--tab NAME]` | Print a tab's board as JSON, each task with when it last changed and from which terminal (`--since`: only those changed since), or remove the board. |

`bun run install-cli [DIR]` installs the command as a small script in `~/.local/bin` (or `DIR`) that runs your checkout, so `git pull` updates it; run it again if you move the checkout. Without it, run `bun run dev <command>` inside the checkout.

## Upgrading

```sh
cd spectraweaver
git pull
bun install
spectraweaver down && spectraweaver up
```

Then reload the page. This restarts only the web server, which picks up the new UI and server code; sessions keep running. The daemon is replaced only by `spectraweaver down --all`, which ends every session; afterwards **↻ Restore** opens them again, resuming their agents' conversations, but programs other than Claude Code and Codex start over.

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
