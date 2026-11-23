import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export function stateDirectory({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (env.COPILOT_PROXY_DATA_DIR) return resolve(env.COPILOT_PROXY_DATA_DIR);
  if (platform === 'win32') {
    if (!env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is required on Windows.');
    return join(env.LOCALAPPDATA, 'CopilotProxy');
  }
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'CopilotProxy');
  const state = env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : join(home, '.local', 'state');
  return join(state, 'copilot-proxy');
}

export async function readLocalToken(config, {
  configPath, platform = process.platform, env = process.env, executeImpl = execute,
} = {}) {
  if (env.COPILOT_PROXY_LOCAL_TOKEN) return env.COPILOT_PROXY_LOCAL_TOKEN;
  const tokenPath = env.COPILOT_PROXY_LOCAL_TOKEN_FILE || config.localTokenPath;
  if (!tokenPath && platform === 'win32') {
    if (!config.sourceDir) throw new Error('Missing Windows installation source directory.');
    const childEnv = { ...env };
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN', 'COPILOT_PROXY_LOCAL_TOKEN']) delete childEnv[key];
    const { stdout } = await executeImpl(config.pwshPath || 'pwsh.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', join(config.sourceDir, 'token.ps1')],
      { env: childEnv, windowsHide: true, timeout: 10_000, maxBuffer: 16_384 });
    return stdout.trim();
  }
  const path = tokenPath || join(dirname(configPath), 'local-key');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Local key must be a regular file.');
    if (platform !== 'win32' && ((stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid()))) {
      throw new Error('Local key must belong to this user and have mode 0600.');
    }
    if (stat.size > 16_384) throw new Error('Local key is too large.');
    return (await file.readFile('utf8')).trim();
  } finally {
    await file.close();
  }
}

export async function loadRuntimeConfiguration(options = {}) {
  const env = options.env || process.env;
  const configPath = env.COPILOT_PROXY_CONFIG || join(stateDirectory(options), 'installation.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (!config || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) {
    throw new Error('Invalid port in installation configuration.');
  }
  const localToken = await readLocalToken(config, { ...options, env, configPath });
  if (typeof localToken !== 'string' || localToken.length < 32 || /[\r\n]/.test(localToken)) {
    throw new Error('A strong local bearer key is required.');
  }
  return { config, configPath, localToken };
}
