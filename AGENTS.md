# Set up the local Copilot proxy

Follow this guide when a user asks you to configure or verify this proxy. The
service connects Codex to GitHub Copilot over the OpenAI Responses API.

## Check the target machine

1. Use a shell on the same machine and under the same OS account as the Codex
   client. The proxy listens on `127.0.0.1`. A cloud agent or a separate
   container needs a shell in the environment where the client runs.
2. Look for an existing installation before cloning or installing. Read only
   `sourceDir` and `port` from `installation.json` in the state directory below.
   Use that checkout and port for verification. If the requested profile or
   desktop integration already works, leave the installation in place. If the
   saved checkout is missing, inspect the existing installation before trying
   to install from another directory.
3. If there is no existing checkout, clone to a permanent, user-owned directory.
   The service and Codex profile reference scripts there. Run the remaining
   commands from the checkout.

| OS | Default state directory | Background startup |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%\CopilotProxy` | `CopilotProxy` scheduled task at user sign-in |
| Linux | `$XDG_STATE_HOME/copilot-proxy` or `~/.local/state/copilot-proxy` | `systemd --user` |
| macOS | `~/Library/Application Support/CopilotProxy` | `launchd` user agent in a GUI session |

Linux and macOS also support a custom state directory through
`COPILOT_PROXY_DATA_DIR`.

```sh
git clone https://github.com/allensu0314/copilot-local-proxy.git
cd copilot-local-proxy
```

## Check prerequisites

- Check for Node.js 22 or later, GitHub CLI (`gh`), and Codex 0.134 or later
  with v2 profiles and command-backed provider authentication. On Windows,
  PowerShell 7 (`pwsh.exe`) is also required, and the launcher can use the
  installed Codex app's bundled CLI. Install any missing prerequisites from
  their official distribution or the OS package manager. The proxy has no npm
  dependencies.
- Run `gh auth status --hostname github.com` with `GH_TOKEN` and `GITHUB_TOKEN`
  unset in that process so it checks the saved login. If sign-in is needed, run
  `gh auth login --hostname github.com` in the same environment and have the
  user complete the browser step. The account needs Copilot access and access
  to the default native Responses model, `gpt-6.1-sol`.
- Let the installer and Codex's auth helper handle credentials. Keep GitHub
  tokens and the generated local key out of chat, logs, and config files.

## Install for the requested client

Run one of the following as the target user. On a fresh installation the
default creates the `copilot-local` CLI profile. `--desktop` also changes the
provider for new local Codex desktop chats. Use it when the user requests
desktop integration.

```sh
# Dedicated CLI profile
node manage.mjs install

# CLI profile plus the desktop default
node manage.mjs install --desktop
```

On Linux or macOS without a user service manager, use
`node manage.mjs install --no-service`, adding `--desktop` if requested. Start
`npm start` in a separate terminal and keep it running, or use the user's
process manager if they need it to persist. On Windows use the scheduled task
installed by `node manage.mjs install`.

The default port is `39117`. For a new installation with a port conflict,
choose a free port and pass `--port <port>` to the installer. Use the resulting
port in verification and report it to the user. If the installer detects an
unmanaged profile, task, or service, inspect the conflict before making changes.

## Verify the result

1. Check `/health` on the configured port. Expect
   `{"status":"ok","service":"copilot-proxy"}`. This checks the listener.
   On Windows use `curl.exe` in place of `curl`.

   ```sh
   curl --noproxy '*' --fail --silent --show-error --max-time 5 http://127.0.0.1:39117/health
   ```

2. Run a real request through the installed Codex profile from the checkout.
   Expect a successful exit and `CONNECTED` as the model's reply.

   ```sh
   node manage.mjs codex exec --ephemeral "Reply exactly CONNECTED. Do not use tools."
   ```

3. For desktop integration, verify a new **local Codex chat** after setup.
   Fully quit and reopen the app if a new chat still uses the previous provider.
   If you lack access to the desktop session, report the CLI smoke test result
   and give the user this final desktop check.

If the listener check fails, inspect the platform's task or user service and
`service.log` in the state directory. If the listener is healthy but the model
request fails, check the request ID and redacted error in that log. A 401 points
to credentials, a 403 can indicate Copilot access or organization policy, and a
502 can indicate upstream connectivity. See [troubleshooting](README.md#status-and-troubleshooting)
for the commands and error codes.

Report the installed mode, loopback base URL (`http://127.0.0.1:<port>/v1`), and
which verification steps passed. For interactive CLI use, run
`node manage.mjs codex` from the checkout. For desktop use, start a new local
Codex chat in the app. The managed uninstall command is `node manage.mjs uninstall`.
Stop any manually started foreground process before uninstalling.
