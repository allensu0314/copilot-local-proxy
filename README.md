# Local Copilot proxy

A dependency-free Node HTTP service forwarding native OpenAI Responses to
`https://api.githubcopilot.com`. No VS Code, nested coding agent, protocol
conversion, or external database is involved. Codex executes its own tools.
Copilot licensing, model access, organization policies, and usage limits still
apply. The Copilot endpoint is not a guaranteed public third-party API and may
change.

## Set up with a coding agent

Paste this into an agent running on the computer where you use Codex:

```text
Set up the local Copilot proxy for me using https://github.com/allensu0314/copilot-local-proxy. Follow AGENTS.md, use the dedicated Codex CLI profile, and verify it with a real request.
```

For Codex desktop, replace “use the dedicated Codex CLI profile” with “make it
the default for new local Codex desktop chats.” [Agent setup guide](AGENTS.md)

## Windows, Linux, and macOS

The HTTP service runs on all three platforms with Node 22+ and a stored GitHub
CLI (`gh`) login entitled to Copilot. PowerShell 7 is required only on Windows.
No npm dependencies need to be installed.

| Platform | Background startup | Local state and key |
| --- | --- | --- |
| Windows | Existing per-user Task Scheduler task | `%LOCALAPPDATA%\CopilotProxy`, DPAPI-encrypted key |
| Linux | `systemd --user` service | `$XDG_STATE_HOME/copilot-proxy`, or `~/.local/state/copilot-proxy`; directory `0700`, key `0600` |
| macOS | User `launchd` agent | `~/Library/Application Support/CopilotProxy`; directory `0700`, key `0600` |

Run from this checkout after installing Node, GitHub CLI, and Codex:

```sh
gh auth login --hostname github.com
npm test
node manage.mjs install
node manage.mjs codex
```

Use `node manage.mjs install --desktop` to select this provider for new Codex
desktop chats. Without `--desktop`, the dedicated `copilot-local` CLI profile
is installed and desktop defaults are preserved. Requires a Codex client with
v2 configuration profiles and command-backed authentication (0.134+).
On Windows, the command delegates to the existing PowerShell installer and
launcher. The Windows commands below remain supported.

Linux/macOS installation records the absolute Node and GitHub CLI paths, so
login services can run without an interactive shell's PATH. The generated
Codex auth command reads the local key with Node; it does not require
PowerShell. The source checkout and the recorded executable paths must remain
available; reinstall after moving them. A reinstall preserves the local key,
backs up changed Codex configuration, and retains an enabled desktop integration.

For a Linux container, WSL session without systemd, or foreground development:

```sh
node manage.mjs install --no-service --port 39117
npm start
# In another terminal:
node manage.mjs codex exec "Reply exactly CONNECTED. Do not use tools."
```

`--no-service` is available on Linux/macOS. Run `npm start` under the process
manager of your choice. Linux/macOS services start at user login; Linux does
not enable system-wide lingering or require sudo. A Linux user session must
provide a working `systemctl --user` bus. macOS installation requires a logged-in
GUI session. Use `--no-service` when these facilities are unavailable.

The service can locate its installation configuration and local key without
environment bearer credentials. `COPILOT_PROXY_CONFIG` selects an explicit
configuration file; `COPILOT_PROXY_LOCAL_TOKEN_FILE` selects a local key file.
On Unix, the key must be a regular file owned by the current user, with no group
or other permissions; symlink keys are rejected. `COPILOT_PROXY_DATA_DIR`
selects a custom Linux/macOS state directory at installation time.
`COPILOT_PROXY_CODEX_PATH` optionally selects the Unix Codex CLI executable.

Linux/macOS write redacted rotating `service.log` / `service.previous.log` files
in the state directory, with a 2 MiB rotation threshold. Useful native controls:

```sh
# Linux
systemctl --user status copilot-proxy.service
systemctl --user restart copilot-proxy.service
systemctl --user disable --now copilot-proxy.service
# macOS (run in a logged-in GUI session)
launchctl print "gui/$(id -u)/com.copilot.proxy"
launchctl kickstart -k "gui/$(id -u)/com.copilot.proxy"
launchctl bootout "gui/$(id -u)/com.copilot.proxy"
```

Remove the managed service, local key, and client integration with
`node manage.mjs uninstall`. Logs and configuration backups are retained;
desktop values changed by the user after installation are preserved. A manually
started foreground process must be stopped separately before uninstalling.
Unmanaged client profiles, providers, and service files are never overwritten.

GitHub Actions runs the test suite on Windows, Linux, and macOS with Node 22
and 24, including native service-file validation on Unix.

## Windows installed usage

Open the installed **Codex desktop app**, select **Codex** mode, and start a
**new local chat**. On this app build the window is titled ChatGPT. The desktop
default provider is **Local GitHub Copilot**; no terminal command, VS Code
window, or environment variable is needed. Existing chats may retain their
previous provider. If a new chat retains the old provider, fully quit and reopen
the app before creating another chat.

The desktop integration backs up `~\.codex\config.toml` under the protected
`%LOCALAPPDATA%\CopilotProxy` directory. It changes only the top-level default
provider and disables unsupported hosted web search, then adds a marked
`model_providers.copilot-local` block. Existing model, reasoning level, tools,
MCP servers, permissions, and other providers are preserved.

The CLI remains available as an **optional** alternative in a new terminal:

```powershell
codex-copilot
codex-copilot exec "Reply exactly CONNECTED. Do not use tools."
```

In an already-open terminal, use:

```powershell
& "$env:LOCALAPPDATA\CopilotProxy\bin\codex-copilot.cmd"
```

The launcher finds the installed Codex app's bundled CLI, including after app
updates, and selects `~\.codex\copilot-local.config.toml`. It does not replace
Codex or modify existing client authentication.
If `codex` is already on PATH, `codex --profile copilot-local` is equivalent.
The profile defaults to `gpt-6.1-sol`, medium reasoning, HTTP/SSE Responses,
and disables hosted web search. Other account-enabled native Responses models
can be selected with `-m`; adjust the profile's context window for that model.
Existing client tools/MCP configuration is inherited normally.

Base URL: `http://127.0.0.1:39117/v1`. Supported routes:
`GET /health`, authenticated `GET /v1/models`, `POST /v1/responses`, and
`POST /v1/responses/compact` (the last requires upstream support).
No Chat Completions conversion, WebSocket bridge, or server-side tools.

## Install / reinstall

This Windows installer requires Node 22+, PowerShell 7, the installed Codex client (0.134+ profile format
and command-backed provider authentication), and a stored `gh` login whose
account is entitled to Copilot:

```powershell
npm test
pwsh.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\install.ps1 -Desktop
```

No npm install is needed. The installer uses a dedicated per-user Task
Scheduler task, **CopilotProxy**, with an interactive sign-in trigger and no
elevation. After reboot, it starts **after this user signs in**, not before.
It starts immediately on installation, runs on battery, and has no execution
time limit. A small hidden PowerShell supervisor restarts a failed Node worker
after 2-60 seconds. A native one-minute repeating trigger also restarts a
missing supervisor, including after a force-kill; overlapping starts are ignored.
The task's failure-restart policy is an additional safeguard.
The task explicitly uses normal scheduling priority (4). Windows' default
task priority (7) can severely delay child process startup on a busy devbox,
causing even `gh --version` to exceed the credential helper's deadline.
Installation checks authenticated model access through the actual background
worker, not just listener health.
The source directory must remain in place. Reinstall after moving it.
Reinstalling backs up an existing managed profile; an unrelated profile/task
is never overwritten. A previously enabled desktop integration stays enabled
on reinstall. Omit `-Desktop` on a new installation for CLI-profile-only setup.

## Credentials and safety

Upstream credentials stay in GitHub CLI's existing OS credential storage.
`gh auth token --hostname github.com` is captured internally, never logged.
Inherited `GH_TOKEN`, `GITHUB_TOKEN`, and `COPILOT_GITHUB_TOKEN` are deliberately
ignored so an app-injected temporary token is not persisted or required at
sign-in. The stored token is reread every five minutes and after a 401; only a
changed token is retried, before any response stream starts. Long-lived OAuth
revocation/expiration still requires renewing the legitimate `gh` login; this
service cannot renew an authorization that GitHub has revoked.

A separate random local bearer key on Windows is DPAPI-encrypted for this user at
`%LOCALAPPDATA%\CopilotProxy\local-key.dpapi`. That directory is ACL-restricted
to this user and SYSTEM. Codex retrieves only this local key through
`token.ps1`; no secret is written into its TOML, source, command-line arguments,
or logs. Do not print the token helper's output or enable HTTP body/header
debug logging. Same-user processes are within the trust boundary.

Only IPv4 loopback is bound. Browser-origin and non-loopback Host requests
are rejected, with no CORS permission. Only the fixed Copilot upstream is used,
redirects are forbidden, and client headers are not forwarded. Requests are
limited to 16 MiB, four active operations, a 30-second upload, and ten minutes
overall. Streaming uses backpressure and cancels upstream on client disconnect.
SSE comments keep idle streams alive every 15 seconds between events. Each
event is buffered only until its delimiter (up to 16 MiB). For eligible early
stream recovery, up to 1 MiB of initial lifecycle/reasoning-item events is also
held until the first non-prefix event; the whole response is never buffered.
Native terminal events end the local stream immediately,
without waiting for upstream HTTP EOF. If HTTP EOF follows a complete JSON
event without its final blank line, only that missing delimiter is repaired.
The proxy never invents `response.completed`. A real truncation or stream
transport failure produces a native `response.failed` event containing the
request ID. The installed Codex client ignores generic SSE `error` events for
these failures, even with a nested error object, and otherwise falls back to
the misleading `stream closed before response.completed` message. Copilot
error envelopes are converted to redacted `response.failed` events as well.
Copilot can still truncate a generation upstream. A stateless `POST /v1/responses`
with `store: false`, no conversation/previous-response reference, no background
execution, and only client-side function/custom tools (or no tools) can recover
from an early EOF or transient body reset up to twice. Initial
`response.created`, `response.in_progress`, and reasoning-item added/done events
are withheld and discarded on retry, so only the successful attempt's response
ID and prefix reach Codex. Heartbeats continue during initial reasoning.
Any text/reasoning delta, tool-call event, unknown event, or prefix-buffer
overflow commits the attempt and permanently disables stream retries.
Stored/stateful/background requests, hosted tools, native terminal failures,
HTTP errors, and provider error envelopes are never regenerated.
Retries share the original ten-minute deadline, use backoff, and stop on client
cancellation. Failed accepted attempts can still consume Copilot usage even
when their prefix is discarded. Partial output is never replayed, and a
completed response is never synthesized.
Connection-establishment failures (temporary DNS failure, refused/unreachable
connections, or a connect timeout) are retried up to five times, with delays of
250 ms, 1 s, 4 s, 10 s, and 20 s within the same overall deadline. With Node's
default ten-second connect timeout, six timed-out attempts allow approximately
95 seconds for a temporary outage to clear. This recovery applies in existing
long-running chats as well as new ones, and stops on client cancellation.
Transient resets/timeouts reported by Node's
`undici:client:connectError` diagnostics are also retried: this event proves
connection establishment failed before dispatching HTTP headers. The original
error object is tracked in a weak set, without retaining diagnostic payloads,
URLs, or headers. Certificate and unknown errors are not retried.
Pre-header connection resets without that evidence, ambiguous timeouts, HTTP
errors, and committed streams are not replayed: Copilot may have already
accepted those requests. Rate limits are never automatically retried.
Tool continuations are identified as agent requests, not new user prompts.
Upstream error bodies are not echoed or logged.

## Status and troubleshooting

```powershell
Invoke-RestMethod http://127.0.0.1:39117/health
Get-ScheduledTask -TaskName CopilotProxy
Get-Content "$env:LOCALAPPDATA\CopilotProxy\service.log" -Tail 15
```

Health checks confirm the listener only, not licensing or upstream reachability.
The two rotating service logs contain request IDs, status, timing, and redacted
credential-helper outcomes, never prompts, tool output, or credentials.
Transport failures also record an allowlisted error code, attempt number, and
whether a safe connection retry will occur, including `retry_delay_ms` when
retrying. `upstream_connection_recovered` records the successful retry's attempt
number. Exhausted connect timeouts return `upstream_connect_timeout`, with the
allowlisted transport reason and attempt count in the error message.
`phase: "connect"` identifies a failure observed during connection establishment;
`phase: "unknown"` must not be
interpreted as proof the POST was never sent. Match the response's `x-request-id`
header to the log's `request_id`. A 502 indicates a failed upstream connection,
not proof that the stored GitHub login is invalid; unknown transport errors are
recorded as `unknown` without logging their potentially sensitive messages.
For example, repeated `UND_ERR_CONNECT_TIMEOUT` entries with `phase: "connect"`
mean a connection could not be established before HTTP dispatch. They do not
indicate an expired chat session or a rejected credential. A network outage that
outlasts the bounded recovery window can still fail; check VPN/network
reachability and retry the turn once connectivity returns.
For SSE, request logs also contain the last allowlisted event type and any
native terminal event. `completed` refers to local HTTP delivery, not model
completion; only `terminal_event: "response.completed"` confirms that native
completion was observed. `repaired_final_delimiter` identifies an EOF framing
repair. `upstream_stream_error` records a missing terminal event, transport
failure, deadline, or client disconnect without logging event bodies.
`upstream_stream_retry` records an eligible early-stream recovery with
`stream_attempt` and `output_committed: false`. `last_item_type` distinguishes
reasoning, text-message, and tool-call items without recording their contents.
The final request log reports the last attempt's terminal event and attempt
number; `output_committed` means the non-replaceable stream prefix has been sent.
`upstream_stream_incomplete` means the upstream ended without a terminal event.
`upstream_reported_error` means Copilot sent an error envelope; its code is
allowlisted in `provider_error_code`, never its message or body.
`github_auth_timeout` means the credential helper timed out, **not** that the
login is invalid: check task priority/process health before signing in again.
`github_auth_not_signed_in` means no stored login was found; use
`gh auth login --hostname github.com` in that case. A provider 401 means
the stored credential was rejected. A 403 means check entitlement or policy;
429 indicates upstream allowance/rate limits or the local concurrency bound.
Model/endpoint availability is never silently substituted.

```powershell
Stop-ScheduledTask -TaskName CopilotProxy
Start-ScheduledTask -TaskName CopilotProxy
```

The watchdog undoes a stop within a minute. To leave it stopped, first run
`Disable-ScheduledTask -TaskName CopilotProxy`, then stop it. Run
`Enable-ScheduledTask -TaskName CopilotProxy` and start it to resume.

## Uninstall

```powershell
pwsh.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\uninstall.ps1
```

Removes the task, worker, managed profile, local key, and launcher/PATH entry.
Restores the previous desktop provider/web-search setting only when the
installed values are still selected, and removes the marked provider block.
Leaves source, redacted logs, and configuration backups. It never signs out of
GitHub or overwrites unrelated config edits. To revert only the desktop
selection while keeping the service, run `.\configure-desktop.ps1 -Remove`.
