#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, chmod, copyFile, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadRuntimeConfiguration, stateDirectory } from './runtime.mjs';

const execute = promisify(execFile);
const sourceDir = dirname(fileURLToPath(import.meta.url));
const marker = '# Managed by copilot-local-proxy';
const begin = '# BEGIN copilot-local-proxy portable integration';
const end = '# END copilot-local-proxy portable integration';
const managedBlock = /^# BEGIN copilot-local-proxy portable integration\r?\n[\s\S]*?^# END copilot-local-proxy portable integration\r?\n?/gm;
const owned = { model_provider: '"copilot-local"', web_search: '"disabled"' };

async function optionalText(path) {
  try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error('The state directory must be owned by this user and cannot be a symlink.');
  }
  await chmod(path, 0o700);
}

async function atomicWrite(path, text, mode = 0o600) {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, text, { flag: 'wx', mode });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function findExecutable(name, { platform = process.platform, env = process.env } = {}) {
  const names = platform === 'win32' ? [name + '.exe', name + '.cmd', name] : [name];
  const paths = (env.PATH || '').split(delimiter).filter(Boolean);
  if (platform === 'darwin') paths.push('/opt/homebrew/bin', '/usr/local/bin');
  for (const directory of paths) {
    for (const filename of names) {
      const path = resolve(directory, filename);
      try {
        const stat = await lstat(path);
        if (!stat.isFile() && !stat.isSymbolicLink()) continue;
        await access(path, platform === 'win32' ? constants.F_OK : constants.X_OK);
        return path;
      } catch { /* Try the next PATH entry. */ }
    }
  }
  throw new Error(`${name} was not found on PATH. Install it before setting up the proxy.`);
}

export function providerConfiguration({ port, nodePath = process.execPath, directory = sourceDir, configPath }) {
  const tokenArgs = [join(directory, 'manage.mjs'), 'token', ...(configPath ? ['--config', configPath] : [])];
  return 'model = "gpt-6.1-sol"\nmodel_provider = "copilot-local"\nmodel_context_window = 922000\n' +
    'model_reasoning_effort = "medium"\nweb_search = "disabled"\n\n' +
    `[model_providers.copilot-local]\nname = "Local GitHub Copilot"\n` +
    `base_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nsupports_websockets = false\n` +
    `request_max_retries = 0\nstream_max_retries = 0\n\n[model_providers.copilot-local.auth]\n` +
    `command = ${JSON.stringify(nodePath)}\nargs = ${JSON.stringify(tokenArgs)}\n` +
    'timeout_ms = 10000\nrefresh_interval_ms = 300000\n';
}

export async function configureClient({ data, home = homedir(), provider, desktop = false, remove = false }) {
  const path = join(home, '.codex', 'config.toml');
  const profilePath = join(home, '.codex', 'copilot-local.config.toml');
  const statePath = join(data, 'portable-client.json');
  const original = await optionalText(path) || '';
  const rawState = await optionalText(statePath);
  let state = rawState ? JSON.parse(rawState) : undefined;
  const previousProfile = await optionalText(profilePath);
  if (!remove && previousProfile !== undefined && !previousProfile.startsWith(marker)) {
    throw new Error('An unmanaged copilot-local profile already exists; refusing to overwrite it.');
  }
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  let text = original.replace(managedBlock, '');
  if (!remove && desktop && /^\s*\[model_providers\.copilot-local(?:\]|\.)/m.test(text)) {
    throw new Error('An unmanaged copilot-local provider/profile already exists; refusing to overwrite it.');
  }
  const topEnd = text.search(/^[ \t]*\[/m);
  let head = topEnd < 0 ? text : text.slice(0, topEnd);
  const tail = topEnd < 0 ? '' : text.slice(topEnd);
  state ||= { previous: {}, desktop: false };
  if (remove) {
    if (previousProfile?.startsWith(marker)) await unlink(profilePath);
    if (!rawState) return;
    if (!state.desktop) { await unlink(statePath); return; }
  } else {
    const profile = marker + '\n' + provider;
    if (previousProfile !== profile) {
      await mkdir(dirname(profilePath), { recursive: true });
      if (previousProfile !== undefined) await copyFile(profilePath, join(data, `profile-backup-${Date.now()}-${randomBytes(4).toString('hex')}.toml`));
      await atomicWrite(profilePath, profile);
    }
    if (!desktop) { await atomicWrite(statePath, JSON.stringify(state, null, 2) + '\n'); return; }
  }
  if (desktop || (remove && state.desktop)) {
    for (const [key, value] of Object.entries(owned)) {
      const pattern = new RegExp(`^${key}[ \\t]*=[^\\r\\n]*`, 'm');
      const match = head.match(pattern);
      if (!remove) {
        if (!state.desktop) state.previous[key] = match ? match[0] : null;
        const replacement = `${key} = ${value}`;
        head = match ? head.replace(pattern, () => replacement) : replacement + newline + head;
      } else if (match && match[0].trim() === `${key} = ${value}`) {
        const line = new RegExp(`^${key}[ \\t]*=[^\\r\\n]*(?:\\r?\\n|$)`, 'm');
        head = head.replace(line, () => state.previous[key] === null ? '' : state.previous[key] + newline);
      }
    }
    if (!remove) state.desktop = true;
  }
  text = head + tail;
  if (!remove) {
    const providerOnly = provider.slice(provider.indexOf('[model_providers.copilot-local]'));
    text = text.trimEnd() + newline + newline + begin + newline + providerOnly.trimEnd().replace(/\r?\n/g, newline) + newline + end + newline;
  }
  if (text !== original) {
    if ((await optionalText(path) || '') !== original) throw new Error('Codex configuration changed; retry without overwriting it.');
    await mkdir(dirname(path), { recursive: true });
    if (await optionalText(path) !== undefined) await copyFile(path, join(data, `codex-config-backup-${Date.now()}-${randomBytes(4).toString('hex')}.toml`));
    if (!remove) await atomicWrite(statePath, JSON.stringify(state, null, 2) + '\n');
    await atomicWrite(path, text);
  }
  if (remove) await unlink(statePath);
}

function unitQuoted(text, exec = false) {
  if (/[\r\n\0]/.test(text)) throw new Error('Service paths cannot contain line breaks.');
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
  return '"' + (exec ? escaped.replace(/\$/g, '$$$$') : escaped) + '"';
}

function unitPath(text) {
  if (/[\r\n\0]/.test(text) || text !== text.trim()) throw new Error('Service paths cannot contain line breaks or surrounding spaces.');
  return text.replace(/%/g, '%%');
}

function xml(text) {
  if (/[\r\n\0]/.test(text)) throw new Error('Service paths cannot contain line breaks.');
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function serviceDefinition({ platform = process.platform, home = homedir(), env = process.env,
  data, directory = sourceDir, nodePath = process.execPath }) {
  const configPath = join(data, 'installation.json');
  if (platform === 'linux') {
    const configHome = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, '.config');
    return {
      path: join(configHome, 'systemd', 'user', 'copilot-proxy.service'),
      content: `${marker}\n[Unit]\nDescription=Local GitHub Copilot proxy\nStartLimitIntervalSec=0\n\n[Service]\n` +
        `Type=simple\nExecStart=${unitQuoted(nodePath, true)} ${unitQuoted(join(directory, 'server.mjs'), true)}\n` +
        `WorkingDirectory=${unitPath(directory)}\nEnvironment=${unitQuoted('COPILOT_PROXY_CONFIG=' + configPath)}\n` +
        'Restart=always\nRestartSec=2\nTimeoutStopSec=5\nUMask=0077\n\n[Install]\nWantedBy=default.target\n',
    };
  }
  if (platform === 'darwin') return {
    path: join(home, 'Library', 'LaunchAgents', 'com.copilot.proxy.plist'),
    content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
      `<!-- ${marker} -->\n<plist version="1.0"><dict>\n<key>Label</key><string>com.copilot.proxy</string>\n` +
      `<key>ProgramArguments</key><array><string>${xml(nodePath)}</string><string>${xml(join(directory, 'server.mjs'))}</string></array>\n` +
      `<key>WorkingDirectory</key><string>${xml(directory)}</string>\n` +
      `<key>EnvironmentVariables</key><dict><key>COPILOT_PROXY_CONFIG</key><string>${xml(configPath)}</string></dict>\n` +
      '<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>2</integer>\n</dict></plist>\n',
  };
  throw new Error('Use install.ps1 for the Windows Task Scheduler service.');
}

async function serviceAction(definition, install, { platform, executeImpl = execute }) {
  const previous = await optionalText(definition.path);
  if (previous !== undefined && !previous.includes(marker)) throw new Error('An unmanaged service already exists.');
  if (install) {
    await mkdir(dirname(definition.path), { recursive: true });
    await atomicWrite(definition.path, definition.content);
  } else if (previous === undefined) return;
  if (platform === 'linux') {
    if (install) {
      await executeImpl('systemctl', ['--user', 'daemon-reload']);
      await executeImpl('systemctl', ['--user', 'enable', 'copilot-proxy.service']);
      await executeImpl('systemctl', ['--user', 'restart', 'copilot-proxy.service']);
      await executeImpl('systemctl', ['--user', 'is-active', '--quiet', 'copilot-proxy.service']);
    } else {
      const stoppedOrUnavailable = async args => {
        try { await executeImpl('systemctl', args); }
        catch (error) {
          if (error.code !== 'ENOENT' && !/Failed to connect to .*bus|Unit .*(?:does not exist|not loaded)/i.test(error.stderr || '')) throw error;
        }
      };
      await stoppedOrUnavailable(['--user', 'disable', '--now', 'copilot-proxy.service']);
      await unlink(definition.path);
      await stoppedOrUnavailable(['--user', 'daemon-reload']);
    }
  } else {
    const domain = `gui/${process.getuid()}`;
    try { await executeImpl('launchctl', ['bootout', `${domain}/com.copilot.proxy`]); }
    catch (error) { if (error.code !== 3 && error.code !== 113) throw error; }
    if (install) {
      await executeImpl('launchctl', ['bootstrap', domain, definition.path]);
      await executeImpl('launchctl', ['kickstart', '-k', `${domain}/com.copilot.proxy`]);
    } else await unlink(definition.path);
  }
}

export async function installPortable({ port = 39117, desktop = false, service = true,
  platform = process.platform, home = homedir(), env = process.env, directory = sourceDir,
  nodePath = process.execPath, ghPath, executeImpl = execute } = {}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be an integer from 1024 to 65535.');
  if (!['linux', 'darwin'].includes(platform)) throw new Error('Portable installation requires Linux or macOS. Use install.ps1 on Windows.');
  const data = stateDirectory({ platform, env, home });
  const configPath = join(data, 'installation.json');
  const oldConfig = await optionalText(configPath);
  if (oldConfig && JSON.parse(oldConfig).sourceDir !== directory) throw new Error('Another installation owns this state directory.');
  const helper = ghPath || await findExecutable('gh', { platform, env });
  if (service) {
    const definition = serviceDefinition({ platform, home, env, data, directory, nodePath });
    const previous = await optionalText(definition.path);
    if (previous !== undefined && !previous.includes(marker)) throw new Error('An unmanaged service already exists.');
  }
  if (!service && oldConfig && JSON.parse(oldConfig).service) {
    await serviceAction(serviceDefinition({ platform, home, env, data, directory, nodePath }), false, { platform, executeImpl });
  }
  await privateDirectory(data);
  const clientState = await optionalText(join(data, 'portable-client.json'));
  const useDesktop = desktop || Boolean(clientState && JSON.parse(clientState).desktop);
  const localTokenPath = join(data, 'local-key');
  try { await writeFile(localTokenPath, randomBytes(32).toString('base64') + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const config = { sourceDir: directory, nodePath, ghPath: helper, port, localTokenPath,
    logPath: join(data, 'service.log'), service };
  const { readLocalToken } = await import('./runtime.mjs');
  const token = await readLocalToken(config, { platform, env: {}, configPath });
  if (token.length < 32 || /[\r\n]/.test(token)) throw new Error('The stored local key is invalid.');
  await configureClient({ data, home, desktop: useDesktop, provider: providerConfiguration({ port, nodePath, directory, configPath }) });
  await atomicWrite(configPath, JSON.stringify(config, null, 2) + '\n');
  if (service) {
    try { await serviceAction(serviceDefinition({ platform, home, env, data, directory, nodePath }), true, { platform, executeImpl }); }
    catch (error) { throw new Error(`User service setup failed. Use install --no-service when no user service manager is available. ${error.message}`); }
  }
  return { data, configPath, config };
}

export async function uninstallPortable({ platform = process.platform, home = homedir(), env = process.env,
  directory = sourceDir, executeImpl = execute } = {}) {
  const data = stateDirectory({ platform, env, home });
  const path = join(data, 'installation.json');
  const config = JSON.parse(await readFile(path, 'utf8'));
  if (config.sourceDir !== directory) throw new Error('Another installation owns this configuration.');
  if (config.service) await serviceAction(serviceDefinition({ platform, home, env, data, directory }), false, { platform, executeImpl });
  await configureClient({ data, home, remove: true });
  for (const file of [join(data, 'local-key'), path]) await unlink(file);
}

async function runInherited(command, args, env = process.env) {
  const child = spawn(command, args, { stdio: 'inherit', windowsHide: true, env });
  const code = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
  });
  process.exitCode = code;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'token') {
    const { values } = parseArgs({ args, options: { config: { type: 'string' } } });
    const env = { ...process.env, ...(values.config ? { COPILOT_PROXY_CONFIG: values.config } : {}) };
    delete env.COPILOT_PROXY_LOCAL_TOKEN;
    if (values.config) delete env.COPILOT_PROXY_LOCAL_TOKEN_FILE;
    const { localToken } = await loadRuntimeConfiguration({ env });
    process.stdout.write(localToken + '\n');
  } else if (command === 'codex') {
    if (process.platform === 'win32') await runInherited('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', join(sourceDir, 'codex.ps1'), ...args]);
    else await runInherited(process.env.COPILOT_PROXY_CODEX_PATH || await findExecutable('codex'), ['--profile', 'copilot-local', ...args]);
  } else if (command === 'install') {
    const { values } = parseArgs({ args, options: { port: { type: 'string', default: '39117' }, desktop: { type: 'boolean' }, 'no-service': { type: 'boolean' } } });
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be an integer from 1024 to 65535.');
    if (process.platform === 'win32') {
      if (values['no-service']) throw new Error('--no-service is for Linux/macOS; use install.ps1 on Windows.');
      await runInherited('pwsh.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', join(sourceDir, 'install.ps1'), '-Port', String(port), ...(values.desktop ? ['-Desktop'] : [])]);
    } else {
      const { data } = await installPortable({ port, desktop: values.desktop, service: !values['no-service'] });
      console.log(`Installed: http://127.0.0.1:${port}/v1\nState and redacted logs: ${data}\nCodex: node manage.mjs codex`);
      if (values['no-service']) console.log('Run npm start in a separate terminal to start the service.');
    }
  } else if (command === 'uninstall') {
    if (args.length) throw new Error('uninstall takes no arguments.');
    if (process.platform === 'win32') await runInherited('pwsh.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', join(sourceDir, 'uninstall.ps1')]);
    else { await uninstallPortable(); console.log('Removed the managed service, local key, and client integration. Logs and configuration backups are retained.'); }
  } else {
    if (command && !['help', '--help', '-h'].includes(command)) throw new Error(`Unknown command: ${command}`);
    console.log('Usage: node manage.mjs install [--port 39117] [--desktop] [--no-service]\n       node manage.mjs codex [Codex arguments]\n       node manage.mjs token\n       node manage.mjs uninstall\n\nStart the configured proxy in the foreground with npm start.\n--no-service supports Linux/macOS without a user service manager.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); } catch (error) { console.error(`Proxy setup failed: ${error.message}`); process.exitCode = 1; }
}
