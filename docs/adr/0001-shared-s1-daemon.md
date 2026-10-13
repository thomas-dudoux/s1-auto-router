# One shared, lazily started S1 daemon on a unix socket, failing open

S1 runs as a single Python (uv) daemon shared by every Claude Code session, listening on a unix socket under `~/.cache/s1-auto-router/`. The mod starts it when the socket is missing, and the daemon exits after about 30 minutes idle. The daemon is generic: it takes a state and typed questions and returns per-option probabilities. Routing logic, Routing Config and Decision Trees live in the mod. Every failure (daemon missing, cold start, the 5 s budget exceeded, a bad answer) lets the Spawn proceed unchanged.

## Considered Options

- **One server per session**: simpler lifecycle, but each loaded model costs about 1.5–2 GB of RAM, multiplied by the number of open sessions on a 16 GB machine.
- **An always-on launchd service**: no cold start, but it holds RAM even when Claude Code isn't running and needs a separate install step.
- **Running inference inside the mod process**: not possible, because the model needs the Python MLX runtime.

## Consequences

- The first Spawn after a cold start usually exceeds the budget and goes un-routed. That's accepted.
- The mod and the daemon talk through a versioned request shape, because one daemon can outlive several mod reloads.
- The daemon speaks HTTP/1.1 on the unix socket (`POST /v1/answer`), not a raw protocol: a mod cannot import `node:net`, and `$.http.fetch(url, { socketPath })` is its only way to reach a socket.
- Managed daemon stdout/stderr flow through an in-process pipe reader and a bounded writer queue. A blocked log writer does not block pipe draining; overload drops output. Size/count rotation uses a stable per-log lock and the user-wide logging policy, independent of Routing Config. Direct foreground execution keeps its inherited streams. Activating new daemon code or logging settings requires the existing explicit restart.
