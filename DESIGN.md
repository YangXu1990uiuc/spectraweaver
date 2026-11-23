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
3. **Create sessions.** Make a tab per workstream, such as "agents" and "infra", each with its own arrangement of windows and URL. Click "+ New terminal": a window opens at once in a free spot, in the directory of the terminal used last ("▾" also asks for a directory, a startup command or a size). Give it a banner: "auth refactor".
4. **Switch devices.** Run `claude` in a few tiles, close the laptop, and open the page on the desktop. Everything is where it was. One tile shows **needs input**; click it and answer.
5. **Survive a reboot.** After a server reboot, **↻ Restore** opens every terminal again in its tab, window and directory, and runs `claude --resume <id>` where Claude Code ran (§7.3).

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
  HTTP + WebSocket gateway · auth · agent status · task boards
  tabs / banners in JSON files (no SQLite: its locking is unreliable on NFS) · static UI
        │  Unix socket, versioned protocol
        ▼
spectraweaver daemon   (small, rarely restarted)
  PTYs (Bun.Terminal) · one @xterm/headless engine per session
  mode tracker · query responder · scrollback
        │
        ▼
$SHELL → claude / codex / gemini / anything
```

One binary provides both processes plus the CLI (§11): `spectraweaver daemon`, `spectraweaver server`, and `spectraweaver up`, which starts whichever of the two is not running.

### 3.1 Who owns what

- **Daemon: PTY-level facts.**
  - Session id, command, cwd, size, pid.
  - Created and exited times, exit status.
  - The terminal engine's state: screen and scrollback (§7.1).
- **Server: everything presentational.**
  - Banners, layouts, zoom levels, settings.
  - Status, what would restore each terminal (§7.3), and agent metadata.
- **Restarts.** Restarting the server loses nothing. Restarting the daemon ends running processes; §3.2 covers how that is handled, and §7.3 how the terminals come back.

### 3.2 Process lifecycle

- **Starting.** `spectraweaver up` starts both processes detached, with `setsid`. `spectraweaver autostart on` has cron run it at boot (§10).
  - On distros with `KillUserProcesses=yes` (the upstream systemd default; Ubuntu ships `no`), processes started from an SSH login die at logout unless linger is enabled.
- **Server restarts are free** (upgrades, crashes).
- **Daemon restarts are never automatic** on upgrade: restarting ends every session, so the user picks the moment (`spectraweaver down --all`, `up`, then **↻ Restore**, §7.3).
  - Server and daemon must speak the same protocol version. Requests added since protocol 1's first set (`resize`, `text`) are announced in the hello reply as features, so a newer server works with an older daemon, and says what needs a restarted one.
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
  - `daemon.sock`, `daemon.pid`, `server.json`, and the daemon and server logs (each moved aside, once past 5 MB, when `up` starts its process);
  - `instance.json`: the instance id (names the login cookie) and the remembered port and host;
  - `meta.json`: tabs (with their task boards, §8.7), and for each session its banner, colour, tab, window, whether it is put away, and what would restore it (§7.3);
  - `sessions/<id>/`, with log segments and the last snapshot (later; potentially large, hence the movable state directory).
- **Moving state.** `spectraweaver config state-dir` refuses while SpectraWeaver runs (the running daemon would be lost track of) and copies the tabs and instance settings to the new place.
- **Older directories.** Earlier versions kept state directly in the state base (the flat layout), and the project was first called workstreams (`~/.config/workstreams/`, `~/.local/state/workstreams/`). A daemon started in an older directory keeps using it while it runs, so upgrading only the server keeps every session. `up` copies the former config directory rather than moving it, because other hosts sharing it may still run the old version. Once no daemon runs in an older state directory, `up` moves this host's `meta.json` and `instance.json` out of it.
- **Why not `$XDG_RUNTIME_DIR`:** without linger, it is deleted when the user's last login session ends.
- **Permissions:** directories 0700, files and sockets 0600.

**NFS.** SpectraWeaver never uses file locks and never uses SQLite, the usual causes of trouble on NFS (VS Code Server's lock files are an example). Every file is written to a temporary name and renamed into place, which is atomic on NFS, and nothing relies on inotify. Changes made on another host (a new password, say) are noticed by polling file stamps, after the NFS attribute cache expires. The one NFS-sensitive piece is the daemon's Unix socket file:
- per-host directories keep other hosts from mistaking it for a stale socket and deleting it;
- some NFS servers refuse to create socket files; the daemon then says so and suggests a local state directory;
- `up` and `config` point out when the state directory is on a network filesystem (NFS, SMB, Lustre, GPFS, CephFS, AFS), since a local disk is faster.
- A state directory whose socket path would be too long for a Unix socket (about 100 bytes) is refused by the commands that need the socket, with the advice to run `spectraweaver config state-dir PATH`, which still runs.

### 3.4 Daemon protocol (server ↔ daemon)

- **Framing.** Frames on the Unix socket are `u32 length | u8 kind | payload`, at most 64 MiB.
  - Kind 1 is a JSON message: a request `{t: "req", id, op, …}` (id 0 is one-way and never answered), a response `{t: "res", id, ok, result | error}`, or an event `{t: "evt", ev}`.
  - Kind 2 is output: session id, f64 stream offset, raw bytes. The server forwards these to browsers untouched.
- **Handshake:** `{op: "hello", protocol: 1, client}`, answered with `{protocol, version, pid, features, instance}`. `features` names the requests the daemon answers beyond protocol 1's first set (`["resize", "text"]`), so a newer server or CLI can tell an older daemon what it needs; an unknown request is answered with an error rather than ignored. `instance` is random for each start of the daemon and tells the server whether sessions missing from the list were closed or lost (§7.3).
- **Requests:**
  - `list`
  - `create {cols, rows, cwd?, cmd?, tag?}`; `tag` is echoed in the `created` event (the server puts a tab id there)
  - `resize {session, cols, rows}` (§4.3), answered once the engine has the new size
  - `text {session, lines?}`: the last `lines` lines as plain text (the screen by default, scrollback included past it), rows the terminal wrapped joined, with whether the alternate screen and bracketed paste are on and when the program last printed. For `spectraweaver read` and for telling what an agent shows (§8.2).
  - `input {session, data, binary?}`
  - `subscribe {session}`: answered with a snapshot `{offset, cols, rows, data}`, after which live output follows from `offset`; `snapshot {session}` gives a fresh one to a subscriber
  - `unsubscribe {session}`
  - `focus {session, client, focused}`
  - `close {session}`: SIGHUP, then SIGKILL after 3 seconds
- **Events:**
  - `created {session, tag?}`, `exited {session, code, signal}`, `removed {session}`, `resized {session, cols, rows}`
  - `title {session, title}`, `bell`, `notify {session, kind: "osc9" | "osc777", text}`
  - `cwd {session, cwd}` (from OSC 7)

### 3.5 Server ↔ browser

- **One WebSocket per tab**, multiplexing every session the tab shows.
- **Framing.** It follows the daemon protocol: binary output frames tagged with session id and offset, plus JSON control messages.
- **Snapshots, then offsets.** Every subscription, and every reconnection, starts from a snapshot; each output frame carries its stream offset, so a gap shows up as an error in testing rather than as garbled output. A browser that cannot keep up (32 MiB queued) is disconnected and starts again from snapshots.
- **Hidden pages pause.** After 15 seconds in the background, a page unsubscribes from its sessions, and resubscribes for snapshots when it is shown again. Browsers throttle or freeze background pages, so output piled up unparsed (xterm.js even discards writes beyond 50 MB), and catching up kept terminals blank for a long time; a snapshot costs the same however long the page was away. If no snapshot arrives within 10 seconds of coming back, the connection is presumed dead (for example after sleep) and replaced.

## 4. Terminal size and display model

### 4.1 The invariant

A session's size (cols × rows) is chosen when the session is created and changes only when the user resizes it on purpose (§4.3). It never changes implicitly.

Nothing a viewer does sends a resize to the PTY:
- attaching or focusing;
- resizing the browser window;
- changing the layout, or moving a window;
- zooming;
- opening the page on a phone.

Dragging a window's edge is the explicit resize of §4.3, not a viewing action: it is how a terminal is asked for a new size when the tab is laid out as windows.

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

- **One click, or a dialog.** "+ New terminal" creates a terminal at once: in the first free cell of the tab's grid (else cascaded), at the recommended size below, starting in the current directory of the terminal focused last in the tab (the server reads the shell's directory from `/proc`, or with `lsof` on macOS). "▾" opens the new-terminal dialog, for a working directory, a startup command or an exact size.
- **Pre-filled, never forced.** The dialog has two number fields, columns and rows, pre-filled with a recommendation, and a text size in pixels that describes the same choice in one tile: editing either sets the other. The user edits the numbers directly.
- **The recommendation** is the shape of one tile in the current tab's grid at the user's preferred text size.
  - The preferred text size starts at 13 px. Each time a terminal is created, the text size its chosen size implies becomes the new preference, so recommendations follow the user across layouts.
  - Cells are modelled the way xterm.js's WebGL renderer draws them: glyph advance and line height scale with the font size, then snap to whole device pixels (width down, height up). Ignoring the snapping overestimates the width by up to a pixel per column.
  - A live hint shows the resulting text size and how much of the tile the terminal fills.
- **Why shape matters.** A cell is about 1:2, so a terminal's aspect ratio is about `cols ÷ (2 × rows)`. On a 16:9 screen, a 2 × 4 grid (2 rows of 4) has tiles of aspect about 0.89: 100×56 fills such a tile, while 120×36 leaves about 47% of it blank.
- **Resizing is explicit, and works like a window.** A window's edges and corners (§4.5) are the handles: window and terminal resize together, the terminal area snapping to whole cells at the text size shown, so the window grows or shrinks by cells as a desktop terminal does. The size in the tile's header opens a dialog for exact numbers, or for a text size in pixels (the most cells that fit at that size, and the snapshot then shows that size), which carries the warning about inline TUIs.
  - The size belongs to the session, so every browser follows. The daemon resizes the PTY (SIGWINCH) and its engine at one point of the output stream and emits `resized` there; the server then sends every viewer a fresh snapshot, taking each out of the output fan first, so no viewer parses output meant for the new grid with the old one.
  - The tile that asked keeps its text size exactly: its zoom becomes the fraction of the new fill font that reproduces the old text size (Ctrl + / − then step to the next fixed percentage from there); other viewers keep their zoom and only refit the font.
  - A window whose terminal cannot be resized (an exited program, or a daemon from before resizing) still resizes as a window; its terminal only refits the font.
- **Programs cannot resize either.** xterm.js `windowOptions` stay disabled (the default), so XTWINOPS resize requests are ignored.

### 4.4 Rendering a session into a tile

- **Fit.** `fitFont` is the largest font size at which cols × rows cells fit the tile in both dimensions, like CSS `contain`.
  - Compute it from the font's cell metrics: width is about 0.6 em, and height comes from the line height.
  - Check the result against xterm's actual cell size.
- **Zoom.** Per-tile zoom is a percentage of `fitFont`.
  - 100% is both the default and the maximum; it fills the tile. Ctrl + / − step through fixed percentages; a resize that keeps the text size (§4.3) can leave a tile between two steps.
  - At 100%, Ctrl + goes on by resizing the session (§4.3) to the most cells that fit at a text size one pixel larger, which the snapshot then shows at that size. Beyond this point larger text and a smaller terminal are the same thing, as in a desktop terminal; the resize is explicit, so the invariant of §4.1 holds.
  - Below 100%, the rest of the tile stays blank. The terminal is anchored top-left.
  - Zoom never exceeds 100%, so no row or column is ever cropped, including the bottom row where agents draw their input box.
- **Controls.** These act on the focused tile, and the UI consumes the keys (they are not sent to the terminal):
  - Ctrl + `=` / `−` / `0` (Cmd on macOS);
  - Ctrl + mouse wheel.
- **Layout changes.** Zoom is relative, so changing the layout, moving a window, or resizing the browser window keeps each tile's zoom and only recomputes its font size.
- **How to scale.** Use xterm's `fontSize`, never CSS transforms. Under transforms, xterm.js measures cells wrongly and misplaces the selection (xterm.js #2488, #3242).
- **Extra space** is blank in the MVP.
  - A possible later feature: a read-only strip above the terminal showing the most recent scrollback lines. It is display-only; the program still sees the fixed rows.
  - This does not help alt-screen programs, which have no terminal scrollback.

### 4.5 Views

- **Tabs (workspaces).** The top bar holds tabs; each session belongs to exactly one.
  - A tab has a name, a colour and a grid, all stored on the server, so every device and window sees the same tabs.
  - Each tab has its own URL, `#t=<id>`. One browser tab can switch between workspace tabs, or several windows can each show one (on different monitors, say). The window title and icon show the tab's name and colour so windows are easy to tell apart.
  - Double-click to rename. The context menu recolours, shows the tab's board (§8.7), opens the tab in a new window, or deletes it.
  - Drag a tile by its grip onto a tab to move the session; drag tabs to reorder them.
  - Deleting a tab moves its sessions to the neighbouring tab; processes are never touched. The last tab cannot be deleted.
  - A bell in any session marks its tab, so a workspace that needs attention is visible without switching to it.
- **Windows.** Every terminal is a window, moved by its header and resized by its edges and corners, as on a desktop; windows may overlap, and a press on one brings it to the front. A window's place is a *frame*: position and size as fractions of the workspace plus a stacking order, stored on the server with the session, so every browser shows the same arrangement at its own screen size (a window's terminal refits its font there). A terminal with no frame yet (new, from before windows existed, or moved in from another tab, which drops its frame) takes the first free cell of the tab's grid (2 × 2 unless an older version set another), else cascades from the top-left; every browser works this out the same way, and the first move or resize stores the place. Tabs from before windows thus look the same after an upgrade. The tab's grid also sizes the new-terminal recommendation. Focusing one terminal (⤢) shows it alone, filling the page.
  - **Closing and putting away.** In a tab without a board, **×** closes a terminal, ending its program once the person confirms. In a tab with a board (§8.7), **×** only puts a window away (`hidden` on the session, stored on the server like its frame): its program keeps running, but no browser shows or subscribes to it until its task on the board brings it out. The lead's window has no **×**. Ending a program there takes a right click, on the task or on the window's header, then **Terminate…**, and a confirmation that names the tasks the terminal works on. Only a tab with a board puts windows away, since the board is how they come back: the server refuses `hide` elsewhere, clearing a board brings its tab's windows out, and a window put away in a tab without a board (from an earlier version) shows. A terminal put away that no task names is listed on the board (“+2 off the board”). A terminal that has never been placed comes out over the middle of the tab, as a window a desktop opens.
  - **Snap to grid**, a checkbox in the top bar, kept per browser like zoom: moves and resizes land on grid lines at 36ths of the workspace, so halves, thirds and quarters line up, and the lines show during the drag (brighter at twelfths). Alt during a drag does the opposite. A move snaps the window's top-left corner and keeps its size, so moving never resizes the terminal; a snapped resize keeps the window on its lines and gives the terminal the whole cells that fit, leaving a sliver blank as a grid tile does.
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

- **API.** `Bun.spawn(argv, { cwd, env, terminal: { cols, rows, data } })`, which needs Bun 1.3.5 or later.
- **Shell.** `$SHELL`, falling back to the passwd entry, because systemd services may not set `SHELL`. It starts the way VS Code's terminal starts it:
  - bash on Linux as an ordinary interactive shell, because a login bash reads only `~/.bash_profile` or `~/.profile`, many of which (company ones especially) never source `~/.bashrc`, where aliases and functions live. It inherits the profile's environment from the daemon, which `up` starts from the user's session;
  - other shells, and bash on macOS, as login shells (`-l`), which read the user's rc files too.
  A future systemd service has to import the user's environment, since services get a minimal `PATH`.
- **Startup command.** An optional startup command, such as `claude`, is sent to the interactive shell as type-ahead input, like VS Code's `sendText`. When the command exits, the user is back at a prompt, and the command is in shell history.
- **Environment added:**
  - `TERM=xterm-256color`, `COLORTERM=truecolor`
  - `TERM_PROGRAM=spectraweaver`, `TERM_PROGRAM_VERSION`
  - `SPECTRAWEAVER_SESSION_ID` (hooks would add a per-session secret, §8.3)
  - A UTF-8 locale if none is set.
- **Environment removed:** variables that belong to the terminal the daemon was started from: `VSCODE_*`, `TMUX`, `STY`, the inherited `TERM_PROGRAM`, other terminals' own (`KITTY_*`, `WEZTERM_*`, …), Claude Code's session variables (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, …; by prefix, as new versions add more), and the starting terminal's `SPECTRAWEAVER_SESSION_ID`. Kept, as configuration: `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_USE_*` (the model provider), and `SPECTRAWEAVER_HOME`, `_CONFIG_DIR` and `_STATE_DIR`, so `spectraweaver` commands in a session reach the instance they run in.

### 5.2 Terminal engine

- **One engine per session.** Each session has one `@xterm/headless` terminal, with the same options as the browser:
  - cols, rows and scrollback;
  - unicode11;
  - kitty keyboard support, once pinned to xterm.js 6.1 or later;
  - `windowOptions` disabled.
- **Output pipeline, per chunk:**
  1. `engine.write(chunk)`;
  2. send it to subscribers with its stream offset.
- **Snapshot.**
  1. Wait until the engine has processed everything up to offset X (a write callback).
  2. Serialize.
  3. Stream from X.

  A snapshot contains the `SerializeAddon` output, then the mode tracker suffix (§5.3), then an explicit final cursor position (CUP). It must fit in one frame, where JSON writes each control character as six bytes; a full scrollback of richly coloured text can pass that, and the snapshot then carries less scrollback (2000 lines, 200, none).

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

Rather than hook the parser, the engine reads xterm.js's own state when a snapshot is taken and appends the sequences that re-establish it:
- the SGR mouse encodings (`1006`, `1016`);
- cursor style and blink (DECSCUSR) and visibility (`25`);
- the scroll region (DECSTBM), then the cursor position (CUP), since DECSTBM homes the cursor.

Not restored yet: the `1005`/`1015` mouse encodings, character sets, OSC 8 hyperlinks, and the kitty keyboard flag stack, which a reconnecting client needs to encode keys as the program expects (Shift+Enter and others) once kitty keyboard support is enabled. The title and the cwd are the daemon's (`title`, `cwd` events), not the snapshot's.

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

- **No coalescing.** Each chunk the PTY gives is sent as a frame; Bun's reads are already batched.
- **Slow connections.** A connection (the server) that falls 128 MiB behind is dropped; the server reconnects and every browser gets a fresh snapshot. The server, in turn, drops a browser 32 MiB behind (§3.5).
- **Slow engine.** If the engine falls behind the PTY (for example, `cat` of a huge file), pause reading the PTY if the PTY API allows it. It is not yet known whether Bun.Terminal can (§14).

### 5.7 Logs and exit

- **Raw logs (later).**
  - Raw output could be logged per session in rotating segments, for a history viewer and search (§7.2).
  - For alt-screen programs such a log is mostly redraw traffic. Their history lives inside the program and on disk (`~/.claude/projects/…`, `~/.codex/sessions/…`).
- **Exit.** When the child exits, the session stays visible with its final screen and exit status. Available actions:
  - **Restart:** same command, cwd and size.
  - **Restore** after a daemon restart: see §7.3.
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

- **Title.** User-set text, stored on the server and editable in place (in a windows layout the header drags the window, so a click without a drag edits the banner). It can also be set from inside the session with `spectraweaver banner "$SPECTRAWEAVER_SESSION_ID" "…"`, so an agent can be asked to keep its own banner current.
- **Subtitle (automatic).** Whichever changed most recently:
  - the program's terminal title (OSC 0/2): Claude Code and Codex both set one, and Codex shows `[ ! ] Action Required` while it waits;
  - the last submitted prompt, from Claude Code's `UserPromptSubmit` hook.
- **Status badge** (§8), foreground process name, cwd.
- **Colour.** Each terminal gets a colour from the tab palette, the one least used in its tab, so neighbouring tiles differ. It is stored on the server like the banner, so every browser shows the same colours, and closing a tile never recolours the others. It tints the header and the outline; the focused tile's outline is twice as thick. Moving a terminal to another tab keeps its colour unless a terminal there already has it.
- **All terminal-derived text is rendered as text, never as HTML** (§9).

### 6.5 Thumbnails (filmstrip cards)

- **Content.** A card shows the banner, status, last lines, and a small live preview (DOM renderer or a low-frame-rate simplified canvas).
- **Status first.** At thumbnail size the text is unreadable anyway; status is what matters.

### 6.6 Features that need a secure context

- **Affected features:**
  - `navigator.clipboard`, used for clipboard writes from programs (OSC 52);
  - desktop notifications;
  - PWA installation.
- **Requirement.** These need HTTPS or localhost.
- **OSC 52 without it.** A copy command (`execCommand("copy")`) still writes the clipboard during transient user activation, a few seconds after a key press or click. Programs that copy a mouse selection (Claude Code, Codex) answer a key press or a mouse release, so their copies work on plain HTTP; a blocked copy shows a message that suggests Shift+drag (Option on macOS), which selects in the terminal itself.
- **On plain `http://<ip>`**, the UI lists what is disabled and how to fix it: an SSH tunnel or HTTPS.

### 6.7 Files from the browser

A terminal runs on the server's machine, so a screenshot or a file on the person's own computer is out of its reach, and so is the person's clipboard: an agent's own image paste (Ctrl+V in Claude Code) reads the clipboard of the machine it runs on.

- **Drop or paste.** Files dropped on a terminal's window, or pasted into it without text (a screenshot; the paste key of §6.2, which on Linux is Ctrl+Shift+V, as Ctrl+V goes to the program), go to `POST /api/upload`. The server writes each one and answers its path, and the browser types the paths into that terminal as a paste, after whatever is in its input, without Enter. An agent then takes them as it takes files dragged into a terminal on its own machine. A paste with text pastes the text. Files dropped anywhere else are not opened by the browser; a message says where to drop them.
- **Where.** `spectraweaver-<uid>/uploads` under the system's temporary directory (`$TMPDIR`, else `/tmp`), not the home directory, which is often small. The directory is created 0700 and checked on every upload (a directory, not a link, owned by this user, no access for others), since another user could create it first in a shared `/tmp`. Files are 0600, named by the server (the time, the file's own name with anything a command line would take apart replaced by `-`, and random letters), and removed a week after their upload when the next one arrives.
- **Limits.** 25 MB a file. The server reads a body before refusing it, as a reply sent while the browser is still sending can leave the connection hanging; the server's request limit (25 MB plus a little) bounds what it reads. JSON bodies stay small: a sign-in's beyond 64 KB, or the command-line interface's beyond 4 MB, is not read.
- **Checks.** As every state-changing request: the Origin and Host checks and the login cookie (§9.2).

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

### 7.3 Restoring terminals after a daemon restart or reboot

A reboot, or `spectraweaver down --all`, ends every terminal. What matters most to bring back is the coding agents' conversations, and those outlive the processes: Claude Code and Codex keep them on disk and resume them by id. The rest (tab, window, size, directory) is SpectraWeaver's own.

- **Noting it while the terminal runs.** Every 15 s the server notes, per live terminal, in `meta.json` (written only when something changed):
  - the directory: the agent's if one runs, else the shell's (`/proc/<pid>/cwd`, `lsof` on macOS);
  - the size;
  - the agent in the foreground (§8.2), the flags worth keeping (an allowlist per agent: `--dangerously-skip-permissions`, `--model`, Codex's `-c key=value`, …), and its conversation id.
  A terminal whose program exited has nothing to restore and is noted as such.
- **Finding the conversation id**, most reliable first:
  1. From the agent: Claude Code lists each running session in `<config>/sessions/<pid>.json` (`sessionId`, `cwd`, `startedAt`; a file older than the process is ignored), and Codex keeps its rollout file `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl` open (the npm package runs the real binary as a child, so descendants are searched).
  2. The id found earlier for the same agent process.
  3. An id on the command line (`claude --resume ID`, `codex resume ID`).
  4. The conversation file in the agent's directory written to most recently since the agent started, not taken by another terminal.
  5. None: the restore command then resumes the directory's latest conversation (`claude --continue`, `codex resume --last`).

  `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are read from the agent's environment (`/proc/<pid>/environ`), so a terminal with its own configuration directory works; the daemon passes `CLAUDE_CONFIG_DIR` through to sessions.
- **Lost, not closed.** The daemon's hello carries a random `instance` per start. When the server connects to a daemon whose instance differs from the one it saw last, sessions missing from the list were lost: each with a note is kept in `meta.json`, marked lost. With the same daemon, a missing session was closed while the server was away, and is forgotten. A session closed from the browser is forgotten at once.
- **Restoring.** "↻ Restore N" in the top bar lists the lost terminals, all ticked. Restoring creates a terminal with the noted size and directory (home if it is gone) and the resume command as its startup command, tagged `restore:<lost id>`; when the daemon announces it, the server gives it the lost terminal's tab, window, colour and banner, and forgets the lost one. A plain shell returns in its directory only.
- **The agents' files are not interfaces.** Only their steadiest parts are used: a conversation's id from its file name, its directory from a `cwd` field near the start, and recency from the file's time. Titles (Claude Code's `aiTitle`, `customTitle`, `summary`, `lastPrompt`; Codex's last `user_message`) only label lists, and a list falls back to the directory when they are missing. The resume commands are the agents' documented ones. Codex's SQLite state databases are not used. If Claude Code's per-process file goes away, ids still come from the conversation files (step 4).
- **Recent conversations.** The same dialog lists the conversations written to in the last two weeks that a person started (not `claude -p`, SDK runs, subagents or `codex exec`) and no terminal, live or lost, is on, newest first, to open in new terminals with flags pre-filled from those each agent last ran with. This also recovers terminals lost before their notes existed.
- **Manual by default.** Restoring starts every agent at once; most of them may not be wanted any more. A later, opt-in setting could restore automatically when the daemon starts.
- **Starting at boot** is `spectraweaver autostart on` (§10).
- **Later:** the last screen of each lost terminal (the daemon would save snapshots).

## 8. Agent awareness

### 8.1 Status model

Every terminal whose foreground program is Claude Code or Codex carries an `AgentStatus` (`SessionView.agent`), looked at every 2 seconds and sent to browsers when it changes:

| Activity | Meaning | Shown |
|---|---|---|
| `working` | A turn is running. | blue badge |
| `idle` | The agent waits at its prompt for the next instruction. | grey badge |
| `waiting` | Someone has to answer it: a permission prompt, a question, a dialog. `reason`: `needs approval`, `needs you`, `needs input`. | amber badge and outline; its tab is marked |
| `stopped` | An error ended its turn and it will not go on by itself. `reason`: `at capacity`, `usage limit`, `rate limited`, `safety block`, `context full`, `connection failed`, `login needed`, `API error`, …; `detail`: the agent's own words. | red badge (⚠) and outline; its tab is marked |
| `unknown` | Neither its files nor its screen tell. | the agent's name |

A `warning` (for example `cyber flag`, Codex rerouting a request after flagging it) is shown in red like a stop, even while the agent works. Plain shells and other programs carry no status; the bell (§8.2) still marks them.

### 8.2 Where the status comes from

The agents' own files first, because they are structured, and only their steadiest fields:

- **Claude Code** writes `status` (`busy`, `idle`, `waiting`) and `waitingFor` (`permission prompt`, `dialog open`, `input needed`, …) into its session registry, `<config>/sessions/<pid>.json`, the file restoring already reads for the conversation id (§7.3). A turn an API error ended finishes with an assistant entry marked `isApiErrorMessage` in the transcript, whose `error` names the kind (`overloaded`, `rate_limit`, `billing_error`, `server_error`, `authentication_failed`, `invalid_request`…); safety refusals say "safeguards" in the text. Some versions also write their own reading of a blocked turn (`tempo: "blocked"`, `needs`), which counts as a stop.
- **Codex** (0.171) records `task_started` and `task_complete` (or `turn_aborted`) for each turn in its rollout; a turn an error ended carries `error {message, codex_error_info}`, whose kind (`server_overloaded`, `usage_limit_exceeded`, `cyber_policy`, `context_window_exceeded`, `response_stream_disconnected`…) maps to the reasons above.
- **The screen** fills the gaps: Codex records neither its approval prompts ("Would you like to run the following command?" together with its choices) nor its warnings, and Claude Code's registry misses dialogs shown before its prompt starts (whether to trust a folder). Versions that record less fall back on it too: a program printing in the last 3 seconds is working; a quiet one is stopped if one of the last 15 non-empty lines matches a known error, idle otherwise. Screen text can be anything an agent printed, so it is read only near the bottom and only where the files say nothing.

Verified against Claude Code 2.1.330 (trust dialog, permission prompt, rejection, idle) and the Codex 0.171 source; the tests act out each state with fake agents.

Other generic signals, for any program:

- **Bell** (the engine's `onBell`).
- **OSC 9 and OSC 777 notifications.** Codex sends a plain BEL to terminals it does not recognize; Gemini sends OSC 777 to xterm.js-class terminals.
- **Terminal title changes,** for example Codex's `[ ! ] Action Required`.
- **Foreground process.** On Linux, read `/proc/<shell pid>/stat` field `tpgid`, then `/proc/<pgid>/cmdline`. If the shell itself is in the foreground, no program is running.

### 8.3 Agent integrations

Not built yet; the agents' files (§8.2) give most of this without them. All integrations would be opt-in, installed with `spectraweaver hooks install <agent>`, and do nothing outside SpectraWeaver sessions. Installers merge into existing config files, with a backup, and never overwrite them.

- **Claude Code.** Command hooks call `spectraweaver hook claude-code`, which exits silently when `SPECTRAWEAVER_SESSION_ID` is unset or the server is unreachable.

  | Event | Use |
  |---|---|
  | `Notification` with `permission_prompt` or `idle_prompt` | needs-input |
  | `Stop` | done |
  | `UserPromptSubmit` | subtitle |
  | `SessionStart` | `session_id` (restoring finds it without hooks, §7.3) |

  Claude Code also supports `http` hooks with environment-variable interpolation in headers, but outside SpectraWeaver a command hook fails more quietly.
- **Codex:**
  - `Stop` and `PermissionRequest` hooks;
  - the `notify` program, which runs when a turn completes;
  - recommend `tui.notification_condition = "always"`.

  Title parsing works without any configuration.
- **Gemini CLI.** Enable `general.enableNotifications`, which makes it send OSC 777.
- **Hook authentication.** Hook requests carry `SPECTRAWEAVER_SESSION_ID` and `SPECTRAWEAVER_HOOK_TOKEN`, so the server can attribute and authenticate them.

### 8.4 Surfacing status

- A badge in each terminal's header, and a red or amber outline for a terminal that needs someone (§8.1).
- A mark on the tab, and a count in the browser tab's title ("(2) SpectraWeaver"), for terminals that rang the bell or whose agent waits, stopped or warns.
- `spectraweaver ls` (§11), for scripts and agents.
- Later: optional desktop notifications and sound (these need a secure context).

### 8.5 Updating agents

Updating Claude Code or Codex means restarting every running copy, and Codex cannot be replaced while copies of it run. The way is `spectraweaver down --all`, the update, `spectraweaver up`, then **↻ Restore** (§7.3), which resumes each agent on its conversation in its terminal's place.

An earlier version stopped the agents in place (Ctrl+C pressed twice) and parsed the resume command each prints on exit (`Resume this session with: claude --resume ID`). That depended on the agents' exit messages and on Ctrl+C reaching them at the right moment, and it did not help after a reboot; knowing each conversation id while the agent runs covers both.

### 8.6 Coordinating agents from the command line

Running ten agents by hand does not scale; a coordinating agent can do the rounds instead. SpectraWeaver gives it hands and a display, and nothing more: how tasks are tracked (a repository, files), how agents leave each other messages, and how often it looks are for the prompt the person gives it, not for SpectraWeaver.

- **Hands:** `spectraweaver new --tab NAME --banner TEXT -- COMMAND` opens a terminal (a tab name no tab has makes a tab; run from a SpectraWeaver terminal without `--tab`, it lands in that terminal's tab; 160 × 48 unless `--size`, as a coordinating agent mostly reads it as text), `read` prints its screen, `send` types into it (text then Enter, several lines as one bracketed paste, or keys such as `esc`, `ctrl-c`, `1`), `banner` labels it, `show` and `hide` bring its window out or put it away (§4.5), `close` ends it.
- **Eyes:** `spectraweaver ls --json` lists every terminal with its tab, banner and agent status (§8.1). `wait ID...` blocks until one of them stops working (idle, waiting, stopped, exited; `--all` for all of them, `--until` for some of those states, `--changed` for a state entered after the wait began, `--timeout` with status 124), asking the server once a second; it is for a coordinator with nothing else to do, which can run it in the background, while looking in now and then catches a worker going off track.
- **Messages go through files.** `send` types into the terminal's input box, where it lands in the middle of anything a person is typing there and is sent with it. The help written for the coordinating agent says so: work and reports go through files (a folder per task with a brief and a report, say), and `send` gives a worker its task, or gets an agent going again that stopped (at capacity, rate limited) and will not look at its files until told to.
- **Display:** the task board (§8.7), which the agent pushes for the person to see.
- **Interface.** `read`, `send` and `close` talk to the daemon over its socket, like `new` when no server runs. What only the server knows (tabs, banners, statuses, windows, boards) goes through `/api/v1/sessions` and `/api/v1/board` on the server, authenticated with the login token as a bearer token: the command runs as the same user and reads the token file. A web page cannot send that header across origins without a CORS preflight, which the server never answers, so the interface adds nothing a page could use; the Host check (§9.2) applies as everywhere.
- A program can tell which terminal it runs in from `SPECTRAWEAVER_SESSION_ID`; `ls` marks it.

The same commands are a person's too: a terminal opened with `new --tab` shows up in the browser at once, and the person can look in and step in at any time.

### 8.7 The task board

A display the coordinating agent keeps (§8.6): it pushes the tasks and what each waits for, and SpectraWeaver draws them, with the live state of the terminal working on each. Where the tasks really live (a private repository with a folder per task, say), how they are split and how often the board is pushed are for the agent's prompt; SpectraWeaver neither stores tasks of its own nor changes the board.

- **Format.** `spectraweaver board set [FILE|-] [--tab NAME]` sends `{"title", "tasks": [{"id", "title", "status", "after", "session", "note", "link"}]}` (or just the list), replacing the tab's board; without `--tab`, the board of the tab the command runs in. `status` is one of `todo`, `wip`, `done`, `blocked`; anything finer ("waiting for review") goes in `note`. `after` lists the tasks it waits for; `session` is the terminal working on it. The server checks the board before storing it (ids unique, `after` naming tasks on the board and not in a circle, links `http(s)` only, at most 500 tasks) and answers mistakes in words an agent can act on: `task "T9": "status" must be one of todo, wip, done, blocked, not "review" (say more in "note", …)`. A task naming a terminal that does not exist is a warning, not a refusal. `spectraweaver board --help` is written for the agent. The board is stored with its tab in meta.json, with when it was pushed and from which terminal (`SPECTRAWEAVER_SESSION_ID`: the lead).
- **The window.** The board is a window of its tab like a terminal's: moved, resized and raised, its frame stored with the tab. It has no **×** while the tab has a board, as it is how the tab's windows put away come back (§4.5); a person who wants it smaller resizes it. The first board a tab gets lays the tab out: the board on the left (60%), the terminal that pushed it on the right, in front, and the terminals its tasks name put away; from then on, terminals `spectraweaver new` opens in that tab start put away (`--show` overrides). **Show board** in a tab's menu opens the window even without a board, to say how to get one; that empty board closes. Nothing is fixed beyond that first arrangement.
- **Drawing.** A layered graph (`board-layout.ts`): each task one layer past the deepest task it waits for, layers top to bottom or left to right, whichever fits the window with less shrinking. An arrow that skips layers passes through a waypoint in each, so arrows run between cards and never through one; layers are ordered by barycentre sweeps, keeping the order with the fewest crossings; positions within a layer are the closest to the mean of each node's neighbours that keep the cards apart (isotonic regression). The direction is the person's to choose too (a button in the board: auto, top to bottom, left to right), stored with the board's window so every browser shows the same; the coordinating agent has no say in it, as it never looks at the board. The layout is the same in every browser for the same board, and is recomputed only when tasks or dependencies change. Past 30 tasks the cards take one line.
- **Zoom and pan.** By default the graph fits its window (shrinking to no less than 30%, then scrolling). Ctrl (⌘ on macOS) + wheel zooms around the pointer, from 20% to 300%; Ctrl + `=` / `-` zoom while the board has the focus, and Ctrl + `0` fits the window again; the − / + buttons and the zoom level do the same. A drag on the background pans, as on a map; a plain wheel scrolls. The zoom is kept per browser and tab, like a terminal's text size; these keys reach a terminal only when it has the focus, where they change its text size as before.
- **What a card shows.** Its fill is the agent's status: grey to do, blue in progress, green done, red blocked. Arrows from finished tasks are solid, others dashed. Under the title, the terminal named in `session` and its live state, as its window's badge shows it (§8.1), with how long an agent has been idle (`AgentStatus.since`). A ring marks an alarm, as on a window: red for an agent that stopped or warns, amber for one waiting for an answer, and red for a task in progress whose terminal is closed, exited, or back at its shell prompt (`SessionView.atPrompt`) — no one is working on it. Those last ones are the board's own alarms and mark the tab and the browser title like a terminal's; other states are only words on the card ("idle 18m"). The header counts the alarms; the summary shows progress, how long ago the board was pushed (no threshold: the person judges), and the lead's own state, a click away from its window.
- **Using it.** A click selects a task and shows it in full at the bottom (status, what it waits for, note, link, terminal); a double click, or Enter, brings its terminal out in front of the board, from any tab. The person looks, steps in, and puts it away again with **×**. A right click on a task opens its terminal, puts it away, or terminates it; a right click on the lead's button does the same for the lead.

## 9. Security

### 9.1 Threat model

The UI is a shell. Adversaries:
- other users on the same host (shared work servers);
- other hosts on the network;
- malicious websites open in the user's browser (cross-site WebSocket hijacking, DNS rebinding);
- hostile terminal output (escape sequences injected into the UI).

### 9.2 Controls

- **Listening.** Listen on 127.0.0.1 by default (a Unix socket, mode 0600, is planned). Binding any other address requires `--allow-remote` and prints a warning, because the server speaks plain HTTP; the machine's names and its addresses (the bound one, or every interface's for a wildcard) are added to the Host allowlist automatically, since a DNS-rebinding page arrives with its own name; other names need `--allow-host`. `up` remembers the host and the extra names. The page also refuses to run inside another site's frame (clickjacking); `SameSite=Strict` already keeps framed copies signed out.
- **Authentication** is always on, even on localhost, because other local users can reach 127.0.0.1.
  - **Token.** The first run generates a random token, stored in a 0600 file. `spectraweaver up` prints a login link with it in the URL fragment; the page exchanges it for a cookie and removes it from the address bar and history. `spectraweaver token --rotate` replaces it.
  - **Password (optional).** Set with `spectraweaver passwd` or in Settings, and stored as an argon2id hash. Once it is set, a bookmark of the plain URL is enough: the login page shows `user @ host`, so it is clear whose instance it is, and asks for the password.
  - **Guessing is throttled.** Every local user connects from 127.0.0.1, so the limit is global: after five straight failures, each attempt waits out a lockout that doubles, up to 15 minutes. An attempt counts before its password is checked, so guesses sent at once cannot all slip past the lock while the first are being verified. Token logins are exempt, since tokens cannot be guessed.
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

1. **An SSH local forward** to the server's port: `ssh -L 7777:localhost:7777 host` (straight to a Unix socket once the server can listen on one, §9.2). The page is then served from localhost, which browsers treat as a secure context.
2. **Tailscale Serve.** Valid certificates and tailnet-only access. Hostnames appear in public certificate-transparency logs.
3. **A reverse proxy** with TLS.
4. **Built-in TLS** with a user-provided certificate.
5. **Listening on the network** (`--host 0.0.0.0 --allow-remote`), on a trusted network only. It is the least setup, but plain HTTP: the password, the token and terminal contents cross the network unencrypted, and the features in §6.6 are unavailable.

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
- **Install.** A binary from GitHub Releases plus an install script.
- **Starting at boot.** `spectraweaver autostart on` adds a line to the user's crontab: `@reboot`, run `spectraweaver up` in the user's login shell (so the daemon, and every terminal, gets the `PATH` a login gives, such as `~/.local/bin` from `~/.profile`), retrying every 10 s for 5 minutes, since an NFS home or the network can come up after cron. The line ends with a marker comment, so `on` replaces it and `off` removes it without touching the user's other lines; the state directory is created first, because the line logs into it.
  - **Why cron, not a `systemd --user` unit:** `@reboot` needs neither root nor linger (`loginctl enable-linger`, which company machines often reserve to admins), and a crontab belongs to one host. A unit lives in `~/.config/systemd/user`, which hosts sharing an NFS home share: enabling it on one would start SpectraWeaver on every host at login.
  - Terminals are not restored automatically after the boot; the page offers **↻ Restore** (§7.3).
- **Upgrades.** Replace the binary and restart the server (`spectraweaver down && spectraweaver up`). Daemon upgrades end every terminal, so they wait for `spectraweaver down --all` (§3.2); **↻ Restore** brings the terminals back (§7.3).
- **Memory.** A Bun process holding one 10k-line engine at 200 columns measured 112 MB RSS. Each additional session costs about 17 MB at 120 columns with 10k lines of scrollback.
- **License: Apache-2.0.** The repo root holds `LICENSE` (the official text) and `NOTICE`.
  - Every source file starts with this header:
    ```ts
    // Copyright 2026 The SpectraWeaver Authors
    // SPDX-License-Identifier: Apache-2.0
    // Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver
    ```
  - Anyone who redistributes source derived from these files must keep those notices (Apache-2.0 §4(c)), and derivative distributions must carry the `NOTICE` attributions (§4(d)).
  - CI fails if a source file lacks the header (`scripts/check-headers.ts`).
  - The binary bundles third-party code: the Bun runtime, xterm.js and other dependencies. Generate a third-party notices file at build time, ship it with every release, and show it on the UI's About page.

## 11. CLI

```
spectraweaver up [--host ADDR --allow-remote] | down | status
                                        start/stop daemon + server, show state
spectraweaver autostart [on|off]          start at boot (crontab @reboot)
spectraweaver daemon | server             service entry points
spectraweaver ls [--json] [--tab NAME]    terminals, with each agent's status (§8.1)
spectraweaver new [--tab NAME] [--banner TEXT] [--size 160x48] [--cwd DIR] [--show] [-- CMD...]
spectraweaver read ID [--lines N]         a terminal's screen (and scrollback) as text
spectraweaver send ID TEXT...|- [--no-enter] | --key NAME...
spectraweaver banner ID TEXT
spectraweaver resize ID COLSxROWS
spectraweaver wait ID... [--until STATES] [--all] [--changed] [--timeout 30m]
                                          wait until a terminal stops working (§8.6)
spectraweaver show ID | hide ID           bring a terminal's window out, or put it away (§4.5)
spectraweaver close ID
spectraweaver board set [FILE|-] | show | clear [--tab NAME]
                                        a tab's task board (§8.7)
spectraweaver attach <session>            (planned) emergency access from any terminal (detach: Ctrl+] twice)
spectraweaver hook <agent>                (planned) agent hook entry point (JSON on stdin), §8.3
spectraweaver hooks install <agent>       (planned)
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
- **M3, layouts.** Done: tabs with per-tab grids and URLs, moving sessions between tabs, resizing a session, a windows layout per tab. To do: filmstrip, reordering tiles, PWA.
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
