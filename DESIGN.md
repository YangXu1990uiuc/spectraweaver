# SpectraWeaver — Design

Status: draft v0.1, 2026-09-23. License: Apache-2.0.

## 1. Summary

SpectraWeaver is a self-hosted web app that keeps many long-lived terminal sessions running on a Linux or macOS dev server and shows all of them in the browser. You can close the tab, lose the network, or open the page from another computer: the sessions keep running, and every device sees the same terminals, banners and layout.

It is built for running many CLI coding agents in parallel (Claude Code, Codex CLI, Gemini CLI, and others). Every session is a plain terminal, so any CLI works.

### 1.1 Problem

- **VS Code terminals are not built to persist.**
  - Only a window reload detaches a terminal; closing the window kills it.
  - After a Remote disconnect, terminals survive only for the server's reconnection grace time (3 h by default).
  - The VS Code server exits 5 minutes after the last window leaves, and running terminals do not keep it alive.
  - A VS Code update brings up a new server.
- **tmux and screen persist sessions**, but they add a second UI layer with its own keybindings, scrollback and selection model.
- **With 8 or more parallel agents** it is hard to remember what each terminal is doing, and which one is waiting for you.

### 1.2 Goals

1. **Persistent.** Sessions survive browser close, network loss, and restarts or upgrades of the web server.
2. **Same everywhere.** All state lives on the server: sessions, banners, layouts and settings.
3. **Any CLI.** Sessions are raw PTYs, with no agent-specific wrapping.
4. **VS Code-grade terminal.** Same engine (xterm.js), and VS Code's copy/paste behaviour on each OS.
5. **Viewers never garble sessions.** Nothing a viewer does resizes a PTY: not connecting, resizing a window, changing the layout, or zooming.
6. **Know what each terminal is doing.** Each session has a banner and a status: running, needs input, done, or exited.
7. **Portable.** One self-contained binary for linux-x64 and linux-arm64 (plus macOS), with no root and no tmux.
8. **Secure by default.**

### 1.3 Non-goals

- **Surviving a machine reboot.** Processes cannot survive one. Reviving sessions afterwards (restart + resume) is in scope.
- **Multi-user sharing or permissions.** An instance belongs to one Unix user.
- **Being an IDE.** No file browser, editor or previews.
- **Windows as the server OS.** Bun.Terminal is POSIX-only. Windows is fully supported as a browser client.
- **Unlimited scrollback inside the browser.**

### 1.4 A day with SpectraWeaver

1. **Start it.** On the server, `spectraweaver up` starts the daemon and the server and prints a login link. After setting a password (`spectraweaver passwd`, or in Settings), a bookmark of the plain URL is enough.
2. **Open it.** Open the link through an SSH tunnel or HTTPS, preferably as an app window (§6.3).
3. **Create sessions.** Make a tab per workstream, such as "agents" and "infra", each with its own grid and URL. Click "New terminal": the size is pre-filled to fit the tab's grid; add a working directory and an optional startup command. A tile appears; give it a banner: "auth refactor".
4. **Switch devices.** Run `claude` in a few tiles, close the laptop, and open the page on the desktop. Everything is where it was. One tile shows **needs input**; click it and answer.
5. **Survive a reboot.** After a server reboot, dead sessions show their last screen with a **Revive** button, which runs `claude --resume <id>` in the same directory.

## 2. Key decisions

| # | Decision | Why | Details |
|---|---|---|---|
| D1 | A session's size (cols × rows) is fixed when it is created. Viewers only change the font size. | Resizing is lossy for inline TUIs. A PTY has one size, and every copy of the terminal state must share the same grid. | §4 |
| D2 | A session daemon owns the PTYs. The web server is a separate process that can restart at any time. | When the process holding a PTY master exits, the shell gets SIGHUP. The UI will change often; the daemon should not. | §3 |
| D3 | The daemon runs the same terminal engine as the browser (`@xterm/headless`). | It produces the snapshot a client restores on attach, as VS Code does. It also answers terminal queries when no browser is attached. | §5 |
| D4 | No dependency on tmux. | Needed features arrive only in tmux 3.5–3.7; distros ship older versions. No kitty keyboard protocol. One more layer to reason about. | — |
| D5 | TypeScript everywhere, on Bun. | Bun.Terminal gives a native PTY with no node-pty build. The server and client use the same xterm.js engine. `bun build --compile` cross-compiles single-file binaries. | §10 |
| D6 | Localhost, token auth, and Origin/Host checks by default. | A web terminal is a remote shell. | §9 |
| D7 | Scrollback in memory is bounded; the full raw output goes to logs on disk. | xterm.js allocates every line at full width, so unlimited history in the browser is not feasible. | §7 |

## 3. Architecture

```
Browser (any device)
  xterm.js views · layouts · banners · per-OS keymap
        │  HTTPS/WSS, or an SSH tunnel to localhost
        ▼
spectraweaver server   (restart any time)
  HTTP + WebSocket gateway · auth · status engine · agent hook endpoint
  tabs / banners in JSON files (no SQLite: its locking is unreliable on NFS) · static UI
        │  Unix socket, versioned protocol
        ▼
spectraweaver daemon   (small, rarely restarted)
  PTYs (Bun.Terminal) · one @xterm/headless engine per session
  mode tracker · query responder · ring buffer · raw logs
        │
        ▼
$SHELL → claude / codex / gemini / anything
```

One binary provides both processes plus the CLI (§11): `spectraweaver daemon`, `spectraweaver server`, and `spectraweaver up`, which starts whichever of the two is not running.

### 3.1 Who owns what

- **Daemon: PTY-level facts.**
  - Session id, command, cwd, environment overrides, size, pid.
  - Created and exited times, exit status.
  - The ring buffer, the raw log, and the terminal engine state.
- **Server: everything presentational.**
  - Banners, layouts, zoom levels, settings.
  - Status, revive commands, and agent metadata learned from hooks.
- **Restarts.** Restarting the server loses nothing. Restarting the daemon ends running processes; §3.2 covers how that is handled.

### 3.2 Process lifecycle

- **Services.** Where systemd is available, both processes run as `systemd --user` services, set up by `spectraweaver install-service`. `loginctl enable-linger` keeps them running after logout.
  - Without systemd, `spectraweaver up` daemonizes with `setsid`.
  - On distros with `KillUserProcesses=yes` (the upstream systemd default; Ubuntu ships `no`), processes started from an SSH login die at logout unless linger is enabled.
- **Server restarts are free** (upgrades, crashes).
- **Daemon restarts are never automatic** on upgrade.
  - The UI shows "daemon update pending: restarting ends N running sessions", and the user picks the moment.
  - The protocol is versioned, so a newer server can talk to an older daemon (it supports versions N and N−1).
- **Later hardening (not in the MVP):** keep sessions alive across daemon upgrades, by either:
  - moving PTY ownership into tiny per-session holder processes, or
  - parking the PTY master file descriptors in systemd's fd store (`FileDescriptorStoreMax=`, `FDSTORE=1`).

### 3.3 State locations

Company home directories are often small and shared over NFS by several hosts, so config and state are separate, and state can live anywhere.

- **Config** is a few kilobytes, shared by all of the user's hosts: `$XDG_CONFIG_HOME/spectraweaver/` (default `~/.config/spectraweaver/`), or `$SPECTRAWEAVER_CONFIG_DIR`, or `$SPECTRAWEAVER_HOME/config`. It holds, all mode 0600:
  - `auth.token`;
  - `password`: an argon2id hash, present only if a password is set, so one password works on every host;
  - `config.json`: settings, currently only `stateDir`.
- **State** goes in a **per-host directory** `<state base>/<hostname>/`, because hosts sharing an NFS home must not share a socket, pid files or tabs. The state base is, in order of precedence:
  1. `$SPECTRAWEAVER_STATE_DIR`;
  2. `$SPECTRAWEAVER_HOME/state`;
  3. `stateDir` in `config.json`, set with `spectraweaver config state-dir PATH`; this is the way to keep state on a local or bigger disk without setting environment variables everywhere;
  4. `$XDG_STATE_HOME/spectraweaver/` (default `~/.local/state/spectraweaver/`).
- **A host's state directory holds:**
  - `daemon.sock`, `daemon.pid`, `server.json`, and the daemon and server logs (rotated at 5 MB);
  - `instance.json`: the instance id (names the login cookie) and the remembered port and host;
  - `meta.json`: tabs, banners and which tab each session belongs to;
  - `sessions/<id>/`, with log segments and the last snapshot (later; potentially large, hence the movable state directory).
- **Moving state.** `spectraweaver config state-dir` refuses while SpectraWeaver runs (the running daemon would be lost track of) and copies the tabs and instance settings to the new place.
- **Older directories.** Earlier versions kept state directly in the state base (the flat layout), and the project was first called workstreams (`~/.config/workstreams/`, `~/.local/state/workstreams/`). A daemon started in an older directory keeps using it while it runs, so upgrading only the server keeps every session. `up` copies the former config directory rather than moving it, because other hosts sharing it may still run the old version. Once no daemon runs in an older state directory, `up` moves this host's `meta.json` and `instance.json` out of it.
- **Why not `$XDG_RUNTIME_DIR`:** without linger, it is deleted when the user's last login session ends.
- **Permissions:** directories 0700, files and sockets 0600.

**NFS.** SpectraWeaver never uses file locks and never uses SQLite, the usual causes of trouble on NFS (VS Code Server's lock files are an example). Every file is written to a temporary name and renamed into place, which is atomic on NFS, and nothing relies on inotify. Changes made on another host (a new password, say) are noticed by polling file stamps, after the NFS attribute cache expires. The one NFS-sensitive piece is the daemon's Unix socket file:
- per-host directories keep other hosts from mistaking it for a stale socket and deleting it;
- some NFS servers refuse to create socket files; the daemon then says so and suggests a local state directory;
- `up`, `status` and `config` point out when the state directory is on a network filesystem (NFS, SMB, Lustre, GPFS, CephFS, AFS), since a local disk is faster.

### 3.4 Daemon protocol (server ↔ daemon)

- **Framing.** Frames on the Unix socket are `u32 length | u8 kind | payload`.
  - Kind 1 is a JSON control message.
  - Kind 2 is output: session id, u64 stream offset, raw bytes.
- **Handshake:** `{"hello": {"protocol": 1, "daemonVersion": "…"}}`.
- **Requests:**
  - `list`
  - `create {cmd?, cwd, env, cols, rows}`
  - `input {id, bytes}`
  - `signal {id, sig}`
  - `kill {id}`
  - `subscribe {id, fromOffset?}`
  - `unsubscribe {id}`
  - `focus {id, clientId, focused}`
- **`subscribe` reply.**
  - If `fromOffset` is still inside the ring buffer, the daemon replays the missing bytes.
  - Otherwise it sends a snapshot `{offset, cols, rows, data}`, followed by live output from `offset`.
- **Events:**
  - `created`, `exited {code, signal}`
  - `title {text}`, `bell`, `notify {kind: "osc9" | "osc777", text}`
  - `cwd {path}` (from OSC 7)

### 3.5 Server ↔ browser

- **One WebSocket per tab**, multiplexing every session the tab shows.
- **Framing.** It follows the daemon protocol: binary output frames tagged with session id and offset, plus JSON control messages.
- **Resuming.** The browser remembers the last offset per session, so a brief disconnect resumes without a full snapshot.

## 4. Terminal size and display model

### 4.1 The invariant

A session's size (cols × rows) is chosen when the session is created, and never changes implicitly.

Nothing a viewer does sends a resize to the PTY:
- attaching or focusing;
- resizing the browser window;
- changing the grid or dragging tiles;
- zooming;
- opening the page on a phone.

### 4.2 Why

- **Programs lay out to the terminal size.**
  - Full-screen (alternate-screen) programs simply redraw.
  - Inline TUIs cannot fix output that has already scrolled into scrollback: no escape sequence can address it. So they clear everything and reprint.
    - Codex in scrollback mode answers a width change with `CSI 2J CSI 3J` and replays at most 1000 rows. This wipes all scrollback, including shell output from before Codex started.
    - Gemini CLI also replays.
  - The terminal can reflow only lines it wrapped itself. Program-inserted line breaks, padding, boxes and cursor-positioned layouts cannot be reflowed.
- **Rows matter as much as columns.**
  - Claude Code's fullscreen mode pins its input to the last row.
  - Pagers compute page length from rows.
  - A "10,000-row" PTY would break both.
- **A PTY has exactly one size.** The daemon's engine and every browser's xterm must share one grid, or wrapping and cursor positions diverge.
- **"Size follows the latest client" (tmux's default) is not enough.** It still reflows every time a different device takes over.

### 4.3 Choosing a size

- **Pre-filled, never forced.** The new-terminal dialog has two number fields, columns and rows, pre-filled with a recommendation. The user edits the numbers directly.
- **The recommendation** is the shape of one tile in the current tab's grid at the user's preferred text size.
  - The preferred text size starts at 13 px. Each time a terminal is created, the text size its chosen size implies becomes the new preference, so recommendations follow the user across layouts.
  - Cells are modelled the way xterm.js's WebGL renderer draws them: glyph advance and line height scale with the font size, then snap to whole device pixels (width down, height up). Ignoring the snapping overestimates the width by up to a pixel per column.
  - A live hint shows the resulting text size and how much of the tile the terminal fills.
- **Why shape matters.** A cell is about 1:2, so a terminal's aspect ratio is about `cols ÷ (2 × rows)`. On a 16:9 screen, a 2 × 4 grid (2 rows of 4) has tiles of aspect about 0.89: 100×56 fills such a tile, while 120×36 leaves about 47% of it blank.
- **No resizing in the MVP.** An existing session cannot be resized. A later version may add an explicit "Resize session…" action with a warning about inline TUIs.
- **Programs cannot resize either.** xterm.js `windowOptions` stay disabled (the default), so XTWINOPS resize requests are ignored.

### 4.4 Rendering a session into a tile

- **Fit.** `fitFont` is the largest font size at which cols × rows cells fit the tile in both dimensions, like CSS `contain`.
  - Compute it from the font's cell metrics: width is about 0.6 em, and height comes from the line height.
  - Check the result against xterm's actual cell size.
- **Zoom.** Per-tile zoom is a percentage of `fitFont`.
  - 100% is both the default and the maximum; it fills the tile.
  - Below 100%, the rest of the tile stays blank. The terminal is anchored top-left.
  - Zoom never exceeds 100%, so no row or column is ever cropped, including the bottom row where agents draw their input box.
- **Controls.** These act on the focused tile, and the UI consumes the keys (they are not sent to the terminal):
  - Ctrl + `=` / `−` / `0` (Cmd on macOS);
  - Ctrl + mouse wheel.
- **Layout changes.** Zoom is relative, so changing the grid, dragging tiles, or resizing the window keeps each tile's zoom and only recomputes its font size.
- **How to scale.** Use xterm's `fontSize`, never CSS transforms. Under transforms, xterm.js measures cells wrongly and misplaces the selection (xterm.js #2488, #3242).
- **Extra space** is blank in the MVP.
  - A possible later feature: a read-only strip above the terminal showing the most recent scrollback lines. It is display-only; the program still sees the fixed rows.
  - This does not help alt-screen programs, which have no terminal scrollback.

### 4.5 Views

- **Tabs (workspaces).** The top bar holds tabs; each session belongs to exactly one.
  - A tab has a name, a colour and a grid, all stored on the server, so every device and window sees the same tabs.
  - Each tab has its own URL, `#t=<id>`. One browser tab can switch between workspace tabs, or several windows can each show one (on different monitors, say). The window title and icon show the tab's name and colour so windows are easy to tell apart.
  - Double-click to rename. The context menu recolours, opens the tab in a new window, or deletes it.
  - Drag a tile by its grip onto a tab to move the session; drag tabs to reorder them.
  - Deleting a tab moves its sessions to the neighbouring tab; processes are never touched. The last tab cannot be deleted.
  - A bell in any session marks its tab, so a workspace that needs attention is visible without switching to it.
- **Grid.** Each tab's grid is written in matrix order, rows × columns: "2 × 3" is 2 rows of 3 tiles. Tiles appear in creation order; with more sessions than tiles, the grid scrolls.
- **Focus.** One session in the largest area (`#s=<id>`): same size, bigger font.
- **Filmstrip (later),** for small screens.
  - A main view plus a strip of thumbnail cards, on the left, right or bottom.
  - Click a card, or drag it into the main view, to switch sessions.

### 4.6 Consistency rules

- **Same engine version and width tables.** The daemon's engine and every browser use the same xterm.js version (both are bundled into one binary) and the same Unicode width provider (the unicode11 addon on both sides). Otherwise CJK and emoji widths differ and cursor positions drift.
- **`spectraweaver attach` never resizes the session.**
  - It runs in a real terminal, which cannot be scaled.
  - If the local terminal is smaller than the session, it warns. The local view wraps or crops; the session itself is unaffected.

## 5. Session daemon

### 5.1 Spawning

- **API.** `Bun.spawn([shell, "-l"], { cwd, env, terminal: { cols, rows, data } })`, which needs Bun 1.3.5 or later.
- **Shell.** `$SHELL`, falling back to the passwd entry, because systemd services may not set `SHELL`. A login shell loads the user's profile, which also fixes the minimal `PATH` that systemd gives services.
- **Startup command.** An optional startup command, such as `claude`, is sent to the interactive shell as type-ahead input, like VS Code's `sendText`. When the command exits, the user is back at a prompt, and the command is in shell history.
- **Environment added:**
  - `TERM=xterm-256color`, `COLORTERM=truecolor`
  - `TERM_PROGRAM=spectraweaver`, `TERM_PROGRAM_VERSION`
  - `SPECTRAWEAVER_SESSION_ID`, `SPECTRAWEAVER_HOOK_TOKEN` (a per-session secret), `SPECTRAWEAVER_URL`
  - A UTF-8 locale if none is set.
- **Environment removed:** variables that belong to the terminal the daemon was started from: `VSCODE_*`, `TMUX`, `STY`, and the inherited `TERM_PROGRAM`.

### 5.2 Terminal engine

- **One engine per session.** Each session has one `@xterm/headless` terminal, with the same options as the browser:
  - cols, rows and scrollback;
  - unicode11;
  - kitty keyboard support, once pinned to xterm.js 6.1 or later;
  - `windowOptions` disabled.
- **Output pipeline, per chunk:**
  1. append it to the ring buffer (4 MiB by default) and to the raw log;
  2. `engine.write(chunk, cb)`;
  3. broadcast it to subscribers with its stream offset.
- **Snapshot.**
  1. Wait until the engine has processed everything up to offset X (the write callback).
  2. Serialize.
  3. Stream from X.

  A snapshot contains the `SerializeAddon` output, then the mode tracker suffix (§5.3), then an explicit final cursor position (CUP) with cursor style and visibility.

### 5.3 Mode tracker

`SerializeAddon` restores only part of the terminal state. A round-trip test of 0.14 lost:
- **SGR mouse encoding (`?1006`).** A restored client would send mouse reports in the old X10 format and break mouse handling in Claude Code's fullscreen mode.
- cursor style and blink;
- the window title;
- character sets;
- OSC 8 hyperlinks.

It also has bugs:
- the cursor ends up one column off after a full-row write (xterm.js #6165);
- in the 0.15 beta, the scroll region is emitted after the cursor is placed.

The tracker hooks the engine's parser, with CSI and OSC handlers that observe and then return `false` so default handling still runs. It records:
- mouse encodings: DECSET/DECRST `1005`, `1006`, `1015`;
- cursor visibility (`25`), focus reporting (`1004`), bracketed paste (`2004`);
- DECSCUSR (cursor style);
- the OSC 0/2 title and the OSC 7 cwd;
- the kitty keyboard flag stack (`CSI > u`, `CSI < u`, `CSI = u`). A reconnecting client must encode keys the same way the program expects, or Shift+Enter and other keys break.

When a snapshot is taken, the tracker appends the sequences that re-establish this state.

### 5.4 One responder for terminal queries

- **Why.** Programs probe the terminal, mostly at startup: DA1/DA2, DSR/CPR, DECRQM, the kitty keyboard query `CSI ? u`, XTVERSION, OSC 10/11 colours. Exactly one party must answer, however many browsers are attached:
  - **No browser attached:** nobody answers, so programs time out and degrade (Codex falls back to defaults after 250 ms). This happens for sessions started from the CLI or a script (`spectraweaver new -- codex`, or an agent opening a helper session), for revived sessions, and for anything launched just before the last tab closed.
  - **Two or more browsers attached:** every browser answers, so the program receives duplicate replies. The extra replies arrive as input and show up as garbage, such as `^[[?1;2c` at a shell prompt.
- **The daemon's engine answers.** Headless xterm already answers DA, CPR and mode queries (tested). OSC 10/11 and XTVERSION still need checking; if they are missing, add handlers that answer with the configured theme colours. The engine's `onData` output is written back to the PTY.
- **Browser xterms must not answer.** Register client-side handlers that swallow query sequences (return `true`), while still applying mode changes.

### 5.5 Focus reporting

- **Aggregation.** If a program enables focus reporting (`?1004`), the daemon sends:
  - `CSI I` when the first client focuses the session;
  - `CSI O` when the last one blurs it.
- **Client-generated focus reports are dropped.**
- **Why.** Agent logic such as "notify only when unfocused" (the Codex default) then works correctly across devices.

### 5.6 Backpressure

- **Coalescing.** Output is coalesced into frames of at most about 16 ms or 64 KiB.
- **Slow subscribers.** A subscriber that falls more than N bytes behind is reset to "needs snapshot", rather than buffered without limit.
- **Slow engine.** If the engine falls behind the PTY (for example, `cat` of a huge file), pause reading the PTY if the PTY API allows it. It is not yet known whether Bun.Terminal can (§14).

### 5.7 Logs and exit

- **Raw logs.**
  - Raw output is logged per session in rotating segments (default 64 MiB × 8), for the history viewer and search.
  - For alt-screen programs the log is mostly redraw traffic. Their history lives inside the program and on disk (`~/.claude/projects/…`, `~/.codex/sessions/…`).
- **Exit.** When the child exits, the session stays visible with its final screen and exit status. Available actions:
  - **Restart:** same command, cwd and size.
  - **Revive:** see §7.3.
  - **Remove.**

## 6. Browser client

### 6.1 Terminal

- **Version.** `@xterm/xterm`, pinned to the same version as `@xterm/headless`.
- **Addons:**
  - webgl (can be toggled off)
  - unicode11
  - web-links
  - search
  - clipboard (OSC 52)
  - serialize (for tests)
- **Renderer.**
  - WebGL for the main and focused views, DOM for thumbnails. Chrome allows about 16 WebGL contexts per page.
  - A setting forces DOM everywhere. Claude Code's `/terminal-setup` turns off VS Code's GPU acceleration to avoid garbled text; test both renderers before choosing defaults.
- **Scrollback:** 10,000 lines by default, the same as the daemon (§7).

### 6.2 Keymap: VS Code parity for each client OS (overridable)

| Action | Windows | Linux | macOS |
|---|---|---|---|
| Copy | Ctrl+C when text is selected (and clear the selection); Ctrl+Shift+C | Ctrl+Shift+C | Cmd+C |
| Interrupt (^C) | Ctrl+C with no selection | Ctrl+C | Ctrl+C |
| Paste | Ctrl+V, Ctrl+Shift+V | Ctrl+Shift+V, Shift+Insert | Cmd+V |
| Right click | Copy if there is a selection, else paste | Context menu | Select word |
| Newline in agents | Shift+Enter | Shift+Enter | Shift+Enter |

- **Shift+Enter.** On xterm.js 6.1 or later, programs that request the kitty keyboard protocol receive a real Shift+Enter (Claude Code 2.1.269 or later). Otherwise Shift+Enter sends `ESC CR` (Alt+Enter), which both Claude Code and Codex treat as a newline. Ctrl+J always works.
- **Key handler.** Implement all of this in `attachCustomKeyEventHandler`:
  - Ignore IME composition (`isComposing`, keyCode 229).
  - For copy with a selection, return `false` and let the native `copy` event run xterm's copy handler.
  - For paste, return `false` so the browser fires `paste`. This works on plain HTTP, where `navigator.clipboard` is unavailable.
- **Sanitize pasted text.** Strip ESC; stable xterm.js 6.0 does not strip it inside bracketed paste.
- **UI-reserved keys.**
  - Zoom: Ctrl/Cmd + `=` `−` `0`.
  - Layout navigation, for example Alt+1…9 (configurable).
  - Every other key goes to the terminal.

### 6.3 Browser-reserved shortcuts

- **In a normal Chrome/Edge tab**, the page never receives Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+Shift+T/N/W, Ctrl+Tab, or Ctrl+PgUp/PgDn. Shells use Ctrl+W to delete a word; Codex uses Ctrl+T.
- **Chrome/Edge app windows reserve no keys.** Two ways to get one:
  - an installed PWA (installation requires HTTPS);
  - `--app=URL` (works on plain HTTP).
- **Hint.** The UI checks `display-mode: standalone` and shows a one-time hint when the page is not in an app window.
- **Firefox** has no such exemption.
- **Chrome's Keyboard Lock API** works only in fullscreen.

### 6.4 Tile header (the banner)

- **Title.** User-set text, stored on the server and editable in place. It can also be set from inside the session with `spectraweaver banner "…"`, so an agent can be asked to keep its own banner current.
- **Subtitle (automatic).** Whichever changed most recently:
  - the program's terminal title (OSC 0/2): Claude Code and Codex both set one, and Codex shows `[ ! ] Action Required` while it waits;
  - the last submitted prompt, from Claude Code's `UserPromptSubmit` hook.
- **Status badge** (§8), foreground process name, cwd.
- **All terminal-derived text is rendered as text, never as HTML** (§9).

### 6.5 Thumbnails (filmstrip cards)

- **Content.** A card shows the banner, status, last lines, and a small live preview (DOM renderer or a low-frame-rate simplified canvas).
- **Status first.** At thumbnail size the text is unreadable anyway; status is what matters.

### 6.6 Features that need a secure context

- **Affected features:**
  - clipboard writes from programs (OSC 52);
  - `navigator.clipboard`;
  - desktop notifications;
  - PWA installation.
- **Requirement.** These need HTTPS or localhost.
- **On plain `http://<ip>`**, the UI lists what is disabled and how to fix it: an SSH tunnel or HTTPS.

## 7. History and revival

### 7.1 Scrollback in memory

- **Default:** 10,000 lines in both the daemon engine and the browser (configurable).
- **Memory cost.** xterm.js allocates each line at full width, measured at about 14 bytes per cell, or about 1.7 KB per line at 120 columns:

  | Lines | Per session, per copy | 8 sessions |
  |---|---|---|
  | 10k | ~17 MB | ~135 MB in the browser, plus the same in the daemon |
  | 100k | ~170 MB | ~1.35 GB per browser tab |

- **Only visible tiles** get full xterm instances in the browser.

### 7.2 Full history

- **Raw logs** (§5.7) hold the full history.
- **History viewer (later).** It renders log segments in a read-only terminal view, with search.
- **Agent transcripts** are easier to read inside the agent: Ctrl+O in Claude Code's fullscreen mode, Ctrl+T in Codex.

### 7.3 Revival after a daemon restart or reboot

- **Persisted state.**
  - The daemon persists each session record: command, cwd, environment overrides, size.
  - It also saves the last snapshot, every 30 s and when the session exits.
- **On start**, sessions whose processes are gone become `dead`. Their tile shows the last screen, read-only, with **Revive** and **Remove**.
- **Revive** spawns a new PTY with the same size and cwd and runs the session's revive command. The server fills that command from hooks:
  - **Default:** the original startup command.
  - **Claude Code:** `SessionStart` provides `session_id`, which gives `claude --resume <id>`.
  - **Codex:** `codex resume <id>` if its hook payload carries the id (to verify); otherwise `codex resume --last`.
- **Revival is manual by default.** A later, opt-in setting could revive selected sessions automatically when the daemon starts, for things like dev servers and log tails.

## 8. Agent awareness

### 8.1 Status model

| Status | Meaning |
|---|---|
| `running` | Output is flowing, or an agent reported work in progress. |
| `needs-input` | An explicit signal that the program is waiting for the user. Sticky until the user interacts with the session. |
| `done` | A turn or task finished. Sticky until the user interacts with the session. |
| `idle` | The shell is in the foreground and output is quiet. |
| `exited` / `dead` | The process ended, or it is gone after a daemon restart or reboot. |

### 8.2 Generic signals (no configuration)

- **Bell** (the engine's `onBell`).
- **OSC 9 and OSC 777 notifications.** Codex sends a plain BEL to terminals it does not recognize; Gemini sends OSC 777 to xterm.js-class terminals.
- **Terminal title changes,** for example Codex's `[ ! ] Action Required`.
- **Foreground process.** On Linux, read `/proc/<shell pid>/stat` field `tpgid`, then `/proc/<pgid>/comm`. If the shell itself is in the foreground, no program is running.
- **Output activity timestamps.**

### 8.3 Agent integrations

All integrations are opt-in, installed with `spectraweaver hooks install <agent>`, and do nothing outside SpectraWeaver sessions. Installers merge into existing config files, with a backup, and never overwrite them.

- **Claude Code.** Command hooks call `spectraweaver hook claude-code`, which exits silently when `SPECTRAWEAVER_SESSION_ID` is unset or the server is unreachable.

  | Event | Use |
  |---|---|
  | `Notification` with `permission_prompt` or `idle_prompt` | needs-input |
  | `Stop` | done |
  | `UserPromptSubmit` | subtitle |
  | `SessionStart` | `session_id`, for revive |

  Claude Code also supports `http` hooks with environment-variable interpolation in headers, but outside SpectraWeaver a command hook fails more quietly.
- **Codex:**
  - `Stop` and `PermissionRequest` hooks;
  - the `notify` program, which runs when a turn completes;
  - recommend `tui.notification_condition = "always"`.

  Title parsing works without any configuration.
- **Gemini CLI.** Enable `general.enableNotifications`, which makes it send OSC 777.
- **Hook authentication.** Hook requests carry `SPECTRAWEAVER_SESSION_ID` and `SPECTRAWEAVER_HOOK_TOKEN`, so the server can attribute and authenticate them.

### 8.4 Surfacing status

- Badges on tiles and filmstrip cards.
- A count in the tab title, for example "(2) SpectraWeaver".
- Optional desktop notifications and sound (these need a secure context).

## 9. Security

### 9.1 Threat model

The UI is a shell. Adversaries:
- other users on the same host (shared work servers);
- other hosts on the network;
- malicious websites open in the user's browser (cross-site WebSocket hijacking, DNS rebinding);
- hostile terminal output (escape sequences injected into the UI).

### 9.2 Controls

- **Listening.** Listen on 127.0.0.1 by default (a Unix socket, mode 0600, is planned). Binding any other address requires `--allow-remote` and prints a warning, because the server speaks plain HTTP; a specific bound address is added to the Host allowlist automatically, wildcards need `--allow-host`. The page also refuses to run inside another site's frame (clickjacking); `SameSite=Strict` already keeps framed copies signed out.
- **Authentication** is always on, even on localhost, because other local users can reach 127.0.0.1.
  - **Token.** The first run generates a random token, stored in a 0600 file. `spectraweaver up` prints a login link with it in the URL fragment; the page exchanges it for a cookie and removes it from the address bar and history. `spectraweaver token --rotate` replaces it.
  - **Password (optional).** Set with `spectraweaver passwd` or in Settings, and stored as an argon2id hash. Once it is set, a bookmark of the plain URL is enough: the login page shows `user @ host`, so it is clear whose instance it is, and asks for the password.
  - **Guessing is throttled.** Every local user connects from 127.0.0.1, so the limit is global: after five straight failures, each attempt waits out a lockout that doubles, up to 15 minutes. Token logins are exempt, since tokens cannot be guessed.
  - **The cookie** is HttpOnly and `SameSite=Strict`, marked `Secure` over HTTPS. Its value is an HMAC of the token and the password hash, not a stored session, so logins survive server restarts, while rotating the token or changing the password signs out every browser. Changing the password also drops all open WebSockets.
  - **The cookie name includes the instance id.** Browsers scope cookies by host, not port, so two instances tunnelled to localhost:7777 and localhost:7778 would otherwise overwrite each other's login.
- **Origin and Host checks.** Check `Origin` and `Host` against an allowlist on every WebSocket upgrade and every state-changing request, inside the code path that handles upgrades. Real failures:
  - CVE-2026-53869: middleware did not run on upgrades, so DNS rebinding got past its checks;
  - code-server CVE-2023-26114: no Origin check;
  - marimo CVE-2026-39987: an unauthenticated terminal WebSocket.
- **Terminal output is untrusted** (wetty CVE-2026-49864 was XSS through escape sequences):
  - never put titles, banners or notification text into innerHTML;
  - allowlist link schemes (`http`, `https`) for OSC 8 links and detected links;
  - OSC 52 is write-only: programs may set the clipboard but never read it.
- **Local files.** The daemon socket and the state directory are owner-only (0700 / 0600). Optionally verify the peer's uid with `SO_PEERCRED`.
- **Hooks.** Each session has its own secret; the endpoint ignores requests without a matching one.

### 9.3 Shared machines

Each Unix user runs their own instance; nothing is shared between users.
- **State is per user and per host.** Sockets, tokens, passwords and sessions live in each user's own directories, owner-only; each host gets its own state directory even when the home directory is shared over NFS (§3.3).
- **Ports.** The first `spectraweaver up` takes the first free port from 7777 and remembers it, so URLs and bookmarks stay stable. An explicit `--port` also sticks. If the remembered port is later taken, `up` stops and says so instead of silently moving.
- **Telling instances apart.** `/api/health` reports the server's uid, and `up` accepts a server as its own only if the uid matches. Otherwise, on a shared machine, it could mistake another user's server on the same port for its own and print a link to it.

### 9.4 Remote access, in order of preference

1. **An SSH local forward**, either to the TCP port or straight to the server's Unix socket: `ssh -L 7777:/home/me/.local/state/spectraweaver/server.sock host`. The page is then served from localhost, which browsers treat as a secure context.
2. **Tailscale Serve.** Valid certificates and tailnet-only access. Hostnames appear in public certificate-transparency logs.
3. **A reverse proxy** with TLS.
4. **Built-in TLS** with a user-provided certificate.

## 10. Packaging and operations

- **Builds.** Single-file executables from `bun build --compile`, with the UI assets embedded, for:
  - `bun-linux-x64`, `bun-linux-arm64`
  - `bun-linux-x64-musl`, `bun-linux-arm64-musl`
  - `bun-darwin-arm64`, `bun-darwin-x64`
- **Cross-compiling** works from any host: an arm64 machine produced a working x86-64 binary. A hello-world binary is 99 MB.
- **Requirements.**
  - Linux: glibc 2.17 or later (musl builds for Alpine and others); kernel 3.10 or later (Bun recommends 5.6 or later).
  - macOS.
  - No root, no tmux, no Node.
- **Install.** A binary from GitHub Releases plus an install script. `spectraweaver install-service` writes the `systemd --user` units (daemon and server) and explains linger.
- **Upgrades.** Replace the binary and restart the server unit. Daemon upgrades need the user's confirmation (§3.2).
- **Memory.** A Bun process holding one 10k-line engine at 200 columns measured 112 MB RSS. Each additional session costs about 17 MB at 120 columns with 10k lines of scrollback.
- **License: Apache-2.0.** The repo root holds `LICENSE` (the official text) and `NOTICE`.
  - Every source file starts with this header:
    ```ts
    // Copyright 2026 The SpectraWeaver Authors
    // SPDX-License-Identifier: Apache-2.0
    // Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver
    ```
  - Anyone who redistributes source derived from these files must keep those notices (Apache-2.0 §4(c)), and derivative distributions must carry the `NOTICE` attributions (§4(d)).
  - CI fails if a source file lacks the header, for example using `addlicense -check`.
  - The binary bundles third-party code: the Bun runtime, xterm.js and other dependencies. Generate a third-party notices file at build time, ship it with every release, and show it on the UI's About page.

## 11. CLI

```
spectraweaver up [--host ADDR --allow-remote] | down | status
                                        start/stop daemon + server, show state
spectraweaver daemon | server             service entry points
spectraweaver new [--name N] [--size 120x36] [--cwd DIR] [-- CMD...]
spectraweaver ls
spectraweaver attach <session>            emergency access from any terminal (detach: Ctrl+] twice)
spectraweaver banner [<session>] <text>   session defaults to $SPECTRAWEAVER_SESSION_ID
spectraweaver kill <session>
spectraweaver hook <agent>                agent hook entry point (JSON on stdin)
spectraweaver hooks install <agent>
spectraweaver install-service
spectraweaver passwd [--clear]            set or remove the browser sign-in password
spectraweaver config                      show where config and state live
spectraweaver config state-dir PATH|--reset  move this host's state, e.g. off a small or NFS home
spectraweaver token [--rotate]
```

## 12. Testing

- **Restore round-trip.**
  1. Record real sessions with `script`:
     - Claude Code, classic and fullscreen;
     - Codex, scrollback and fullscreen;
     - vim, htop and less;
     - a shell with colours and wide characters.
  2. Replay each recording into an engine and take a snapshot.
  3. Restore the snapshot into a fresh engine.
  4. Compare buffer contents, cursor position and tracked modes.
- **Query responder.** Start agents with no browser attached, and again with two browsers attached. Check that they detect terminal capabilities without timing out, and that no stray replies reach their input.
- **Size invariant.** Spy on PTY resize calls across attach, layout changes, zoom and window resizes, and check that none happen after creation.
- **Keymaps.** Playwright on Chromium, Firefox and WebKit, simulating keys for each OS:
  - paste over both HTTP and HTTPS;
  - IME composition.
- **Security:**
  - WebSocket upgrades with a bad Origin or Host are rejected;
  - cookie flags are set correctly;
  - no tokens appear in URLs;
  - malicious OSC sequences cannot inject HTML.
- **Load.** 8–16 sessions with heavy output; measure browser memory and frame time.

## 13. Milestones

- **M0, spike: done.**
  - Daemon and server; any number of browsers per session.
  - Snapshot restore, the query responder and the mode tracker.
  - Claude Code and Codex in both of their renderers: still to be checked by hand.
- **M1, MVP.**
  - Done: multiple sessions; grid and focus views; banners; size invariant with zoom; per-OS keymaps; token and password auth; Origin/Host checks; single-binary builds.
  - To do: raw logs, `attach`, systemd units.
- **M2, agent awareness.** Status engine, hook installers, notifications, automatic subtitles, revival.
- **M3, layouts.** Done: tabs with per-tab grids and URLs, moving sessions between tabs. To do: filmstrip, reordering tiles, PWA.
- **M4, release.** Compatibility test suite, CI release pipeline for every target, docs.
- **Later:**
  - History viewer and search.
  - Scrollback strip above tiles.
  - Per-session holders or the systemd fd store.
  - Images (sixel, kitty graphics).
  - Mobile polish.

## 14. Risks and open questions

- **Bun.Terminal is young** (Bun 1.3.5, December 2025). Unknowns: flow control (can reading be paused?), signals, fd access. Keep a PTY adapter interface so node-pty under Node could be swapped in.
- **xterm.js version.** The kitty keyboard protocol is only in the 6.1 beta; 6.0 stable lacks it. Decide which to pin.
- **`SerializeAddon` gaps and bugs.** Covered by the mode tracker (§5.3); consider upstreaming fixes.
- **WebGL rendering.** There are reports of garbled text with Claude Code in VS Code. Keep the renderer toggle and test both renderers.
- **IME and CJK input.** Open xterm.js issues: #4486, #5778, #5887, #6066, and #6112 (with the kitty keyboard protocol).
- **Codex scrollback gaps.** Codex leaves gaps in xterm.js scrollback when output scrolls inside a partial scroll region (openai/codex #27644).
- **Claude Code's copy path.**
  - Claude Code's fullscreen mode copies with native clipboard tools when it thinks it is local, and with OSC 52 over SSH.
  - In a PTY spawned by the daemon it may decide it is local.
  - Verify this, and adjust the environment so it uses OSC 52 if needed.
- **Firefox and Safari keyboard behaviour** (reserved keys) needs testing and documentation.
- **Single daemon vs per-session holders.** In the MVP, upgrading the daemon ends running sessions.
- **Final name**, and the GitHub owner for the repository URL in file headers and `NOTICE`.

## 15. Prior art (September 2026)

| Project | Relation |
|---|---|
| [Dinotty](https://github.com/xichan96/dinotty) (MIT) | Closest match: Rust server with a server-side terminal emulator plus xterm.js, multi-device. Young; no banners or status; processes do not survive a server restart. |
| [Zellij web client](https://zellij.dev/documentation/web-client.html) | Mature, token auth, many clients per session. Zellij draws its own scrollback and selection; modal keybindings. |
| [VibeTunnel](https://github.com/amantus-ai/vibetunnel) | Dashboard that wraps any command. Sessions live in server memory. |
| [agent-deck](https://github.com/asheshgoplani/agent-deck) (web mode) | tmux-based and agent-centric. Token goes in the URL. |
| [nodeterm](https://github.com/eneskirca/nodeterm) Server Edition | Canvas, sticky notes, revive after reboot. BUSL-1.1 license. |
| [ttyd](https://github.com/tsl0922/ttyd), GoTTY, WeTTY (+ tmux) | One command per URL; tmux's UX. |
| `claude --bg` / `claude agents` | Official, Claude Code only, terminal UI only. |

What SpectraWeaver does differently:
- **The size invariant:** viewers never garble sessions.
- **VS Code parity:** same engine, same keymaps.
- **Agent status without wrapping agents.**
- **A restartable UI** in front of a stable daemon.
- **One binary** with no dependencies.

## 16. References

**VS Code**
- pty host restore via headless xterm and `SerializeAddon`: [ptyService.ts](https://github.com/microsoft/vscode/blob/1c0cb337c2dedc6e112b57ef3131a4f40bd505ec/src/vs/platform/terminal/node/ptyService.ts#L1032-L1101)
- reconnection grace time: [PR #274910](https://github.com/microsoft/vscode/pull/274910)
- server auto-shutdown: [serverLifetimeService.ts](https://github.com/microsoft/vscode/blob/1c0cb337c2dedc6e112b57ef3131a4f40bd505ec/src/vs/server/node/serverLifetimeService.ts#L13)
- per-OS terminal clipboard bindings: [terminal.clipboard.contribution.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminalContrib/clipboard/browser/terminal.clipboard.contribution.ts)

**xterm.js**
- memory per cell: [BufferLine.ts](https://github.com/xtermjs/xterm.js/blob/c58ea3637f3968e0e6e79cd92cf9aace7ef89ee2/src/common/buffer/BufferLine.ts#L12-L87)
- unlimited scrollback declined: [#2060](https://github.com/xtermjs/xterm.js/issues/2060)
- `SerializeAddon`: [source](https://github.com/xtermjs/xterm.js/blob/c58ea3637f3968e0e6e79cd92cf9aace7ef89ee2/addons/addon-serialize/src/SerializeAddon.ts#L543-L620), [#6165](https://github.com/xtermjs/xterm.js/issues/6165)
- kitty keyboard protocol: [PR #5600](https://github.com/xtermjs/xterm.js/pull/5600)
- CSS transform issues: [#2488](https://github.com/xtermjs/xterm.js/issues/2488), [#3242](https://github.com/xtermjs/xterm.js/issues/3242)

**Browsers**
- Chromium reserved keys: [browser_command_controller.cc](https://github.com/chromium/chromium/blob/main/chrome/browser/ui/browser_command_controller.cc)
- [Keyboard Lock API](https://developer.chrome.com/docs/capabilities/web-apis/keyboard-lock)
- [Clipboard API spec](https://w3c.github.io/clipboard-apis/)

**Bun**
- Bun.Terminal: [Bun v1.3.5 release notes](https://bun.com/blog/bun-v1.3.5)
- [single-file executables](https://bun.com/docs/bundler/executables)
- [installation and requirements](https://bun.sh/docs/installation)

**Claude Code**
- [fullscreen](https://code.claude.com/docs/en/fullscreen.md)
- [hooks](https://code.claude.com/docs/en/hooks.md)
- [terminal config](https://code.claude.com/docs/en/terminal-config.md)
- [agent view](https://code.claude.com/docs/en/agent-view.md)

**Codex**
- [config reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [hooks](https://learn.chatgpt.com/docs/hooks)
- [#27644](https://github.com/openai/codex/issues/27644)

**Gemini CLI**
- [notifications source](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/utils/terminalNotifications.ts)

**tmux, systemd, and replay buffers**
- tmux: [control mode](https://github.com/tmux/tmux/wiki/Control-Mode)
- systemd: [KillMode](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html#KillMode=), [fd store](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html#FileDescriptorStoreMax=)
- sshx replay buffer: [session.rs](https://github.com/ekzhang/sshx/blob/3604e8ec5ce0e741bd4a7de2e339b980ca8a2d40/crates/sshx-server/src/session.rs#L26)

**Security**
- [OWASP WebSocket cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)
- CVEs: [CVE-2023-26114](https://github.com/advisories/GHSA-frjg-g767-7363), [CVE-2026-39987](https://nvd.nist.gov/vuln/detail/CVE-2026-39987), [CVE-2026-49864](https://nvd.nist.gov/vuln/detail/CVE-2026-49864), [CVE-2026-53869](https://nvd.nist.gov/vuln/detail/CVE-2026-53869)
- [Tailscale Serve](https://tailscale.com/kb/1312/serve)

**Why terminals cannot reflow program layout**
- [DomTerm's structure-aware line breaking](https://per.bothner.com/blog/2017/dynamic-prettyprinting/), one attempt at making the terminal responsible for layout.
