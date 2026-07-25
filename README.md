# Multi CLI Session

Extracted from `SSIS-Builder` and stripped of SSIS, database, patch, bridge, and MCP code.
The server can run local Codex, Claude Code, Cursor Agent, Hermes, GitHub Copilot,
and Kimi CLIs with the user's
subscription login and streams output to a React client over SSE.

## Run

1. Install Node.js 20+ and one or more supported CLIs.
2. Sign in to the CLIs you plan to use. The Connections panel shows and copies the
   relevant setup command for every disconnected provider.
3. Run `npm install`.
4. Run `npm run dev`.
5. Open <http://localhost:5173>.

The server is bound to `127.0.0.1:3001`. Select the provider and model in the UI.
No API key is sent to the browser.

Each project has one primary working directory for Git, snapshots, and the default
command location. Add more folders from the project tree with **Additional folders**.
Codex, Claude, Cursor, GitHub Copilot, and Kimi receive them through their native
`--add-dir` option.

The local API accepts browser requests only from the configured web origin and protects
all chat, history, and workspace routes with an in-memory session token. Override the
allowed development origins with `CHAT_ALLOWED_ORIGINS` when necessary.

## Interactive chat and session access

Assistants can return a structured `relay-question` block that the client renders as
single-choice buttons, multi-select checkboxes, and an optional free-text answer. The
submitted response is stored in the session history and sent back as the next turn.

Each session also stores a provider-specific access preset. Codex exposes chat-only,
read-only, workspace-write, and unrestricted filesystem modes. Claude Code and Cursor
show the equivalent modes supported by their installed CLIs. New sessions start in
the safest chat-only mode.

## Dynamic diagrams

Assistants can return a validated `relay-visual` block that is rendered as a secure,
interactive Mermaid card. Diagram cards support zoom, fullscreen mode, source view,
revision history, source copying, SVG/PNG export, agent-assisted updates and repair,
and links back to referenced workspace files. The latest revision also appears in the
Artifacts sidebar.

Only the `mermaid` renderer is accepted. HTML and executable renderers are rejected,
Mermaid runs with strict security settings, and its code is loaded lazily only when a
conversation contains a diagram.

Workspace-enabled modes use this repository by default. Set `RELAY_WORKSPACE_PATH` on
the server process to point agent sessions at a different project directory.

Before a workspace-enabled run, the server creates a bounded local snapshot (excluding
dependencies, build output, Git metadata, environment files, and credential-like files).
Review cards created by new runs can restore their listed files directly from that snapshot.
Snapshots are retained for 72 hours, up to 40 snapshots by default. Configure this with
`CHAT_SNAPSHOT_RETENTION_HOURS` and `CHAT_MAX_SNAPSHOTS`.

Agent runs have a 15-minute watchdog, SSE heartbeat, and full process-tree termination.
Configure the timeout in milliseconds with `CHAT_RUN_TIMEOUT_MS`. Prompts queued behind
an active run are persisted with the session and recovered after a reload.

Session worktrees can be merged into the project or removed from the Productivity hub.
Both actions require a clean worktree to avoid losing changes.

## Quality checks

Run `npm run check` before shipping changes. Use `npm run test:coverage` for the
built-in coverage report.
The tests include regression coverage for cumulative CLI streams and structured chat widgets.
