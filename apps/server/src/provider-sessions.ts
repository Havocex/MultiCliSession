import { spawn } from 'node:child_process';
import { access, constants, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { getCodexStatus, resolveCodexCli, type CodexCliLaunch } from './codex-session.js';
import type { AgentProvider } from './types.js';

export interface CliLaunch {
  command: string;
  prefixArgs: string[];
  displayPath: string;
}

export interface ProviderStatus {
  connected: boolean;
  detail: string;
  version?: string;
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveClaudeCli(): Promise<CliLaunch | undefined> {
  const override = process.env.CLAUDE_CLI_PATH?.trim();
  const candidates = [
    override,
    process.platform === 'win32'
      ? path.join(process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'), 'npm',
          'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
      : path.join(homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (await exists(candidate)) return { command: candidate, prefixArgs: [], displayPath: candidate };
  }
  return undefined;
}

export async function resolveCursorCli(): Promise<CliLaunch | undefined> {
  const override = process.env.CURSOR_CLI_PATH?.trim();
  if (override && (await exists(override))) {
    return { command: override, prefixArgs: [], displayPath: override };
  }
  if (process.platform === 'win32') {
    const root = path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local'), 'cursor-agent');
    const directNode = path.join(root, 'node.exe');
    const directIndex = path.join(root, 'index.js');
    if ((await exists(directNode)) && (await exists(directIndex))) {
      return { command: directNode, prefixArgs: [directIndex], displayPath: directIndex };
    }
    const versions = path.join(root, 'versions');
    if (await exists(versions)) {
      const names = (await readdir(versions, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .reverse();
      for (const name of names) {
        const node = path.join(versions, name, 'node.exe');
        const index = path.join(versions, name, 'index.js');
        if ((await exists(node)) && (await exists(index))) {
          return { command: node, prefixArgs: [index], displayPath: index };
        }
      }
    }
  }
  return undefined;
}

export async function resolveHermesCli(): Promise<CliLaunch | undefined> {
  const override = process.env.HERMES_CLI_PATH?.trim();
  const candidates = [
    override,
    process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local'),
          'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe')
      : path.join(homedir(), '.local', 'bin', 'hermes'),
    '/usr/local/bin/hermes',
    '/usr/bin/hermes',
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (await exists(candidate)) return { command: candidate, prefixArgs: [], displayPath: candidate };
  }
  return undefined;
}

export async function resolveCopilotCli(): Promise<CliLaunch | undefined> {
  const override = process.env.COPILOT_CLI_PATH?.trim();
  if (override && (await exists(override))) {
    return { command: override, prefixArgs: [], displayPath: override };
  }
  if (process.platform === 'win32') {
    const npmRoot = path.join(process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'), 'npm');
    const loader = path.join(npmRoot, 'node_modules', '@github', 'copilot', 'npm-loader.js');
    const bundledNode = path.join(npmRoot, 'node.exe');
    if (await exists(loader)) {
      return {
        command: await exists(bundledNode) ? bundledNode : process.execPath,
        prefixArgs: [loader],
        displayPath: loader,
      };
    }
  }
  return undefined;
}

export async function resolveKimiCli(): Promise<CliLaunch | undefined> {
  const override = process.env.KIMI_CLI_PATH?.trim();
  const candidates = [
    override,
    process.platform === 'win32'
      ? path.join(homedir(), '.kimi-code', 'bin', 'kimi.exe')
      : path.join(homedir(), '.kimi-code', 'bin', 'kimi'),
    process.platform === 'win32'
      ? path.join(homedir(), '.local', 'bin', 'kimi.exe')
      : path.join(homedir(), '.local', 'bin', 'kimi'),
    process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local'),
          'Programs', 'kimi-code', 'kimi.exe')
      : '/usr/local/bin/kimi',
    '/usr/bin/kimi',
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (await exists(candidate)) return { command: candidate, prefixArgs: [], displayPath: candidate };
  }
  if (process.platform === 'win32') {
    const npmRoot = path.join(process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'), 'npm');
    const entrypoints = [
      path.join(npmRoot, 'node_modules', '@moonshot-ai', 'kimi-code', 'dist', 'main.mjs'),
      path.join(npmRoot, 'node_modules', '@moonshot-ai', 'kimi-code', 'bin', 'kimi.js'),
    ];
    for (const entrypoint of entrypoints) {
      if (await exists(entrypoint)) {
        return { command: process.execPath, prefixArgs: [entrypoint], displayPath: entrypoint };
      }
    }
  }
  return undefined;
}

export async function captureProviderCommand(launch: CliLaunch, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(launch.command, [...launch.prefixArgs, ...args], {
      windowsHide: true,
      env: { ...process.env, NO_OPEN_BROWSER: '1', CURSOR_INVOKED_AS: 'agent' },
    });
    let output = '';
    const timer = setTimeout(() => child.kill(), 15_000);
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.on('error', () => resolve(''));
    child.on('close', () => {
      clearTimeout(timer);
      resolve(output.trim());
    });
  });
}

export async function getProviderStatus(provider: AgentProvider): Promise<ProviderStatus> {
  if (provider === 'codex') return getCodexStatus();
  const launch =
    provider === 'claude' ? await resolveClaudeCli()
    : provider === 'cursor' ? await resolveCursorCli()
    : provider === 'hermes' ? await resolveHermesCli()
    : provider === 'kimi' ? await resolveKimiCli()
    : await resolveCopilotCli();
  if (!launch) {
    return {
      connected: false,
      detail: `${provider === 'copilot' ? 'GitHub Copilot' : provider === 'kimi' ? 'Kimi Code' : provider[0]!.toUpperCase() + provider.slice(1)} CLI was not found.`,
    };
  }
  const [status, version] = await Promise.all([
    captureProviderCommand(
      launch,
      provider === 'claude' ? ['auth', 'status']
      : provider === 'cursor' ? ['about']
      : provider === 'hermes' ? ['status']
      : provider === 'kimi' ? ['provider', 'list', '--json']
      : ['-p', 'auth-check', '--model', '__relay_auth_probe__', '--available-tools=',
          '--no-remote', '--no-remote-export'],
    ),
    captureProviderCommand(launch, ['--version']),
  ]);
  const connected =
    provider === 'claude'
      ? /"loggedIn"\s*:\s*true/i.test(status) || /logged in/i.test(status)
      : provider === 'cursor'
        ? /User Email\s+\S+@\S+/i.test(status) || /logged in|authenticated/i.test(status)
        : provider === 'hermes'
          ? /Provider:\s+\S+/i.test(status) && /✓ logged in|✓ sk-/i.test(status)
          : /model|selected model|does not exist|invalid/i.test(status) &&
            !/No authentication information found|authenticate with GitHub/i.test(status);
  const effectiveConnected = provider === 'kimi'
    ? /"models"\s*:\s*\{/i.test(status) &&
      /kimi-code|managed:kimi-code|moonshot/i.test(status)
    : connected;
  const loginCommand =
    provider === 'claude' ? 'claude login'
    : provider === 'cursor' ? 'agent login'
    : provider === 'hermes' ? 'hermes model'
    : provider === 'kimi' ? 'kimi login'
    : 'copilot login';
  return {
    connected: effectiveConnected,
    detail: effectiveConnected
      ? `Connected through ${provider === 'hermes' ? 'Hermes Agent' : provider === 'copilot' ? 'GitHub Copilot' : provider === 'kimi' ? 'Kimi Code' : provider}.`
      : `Run \`${loginCommand}\` in a terminal.`,
    version: version.split(/\r?\n/).find((line) => line.trim())?.trim() || undefined,
  };
}

export async function resolveProviderCli(provider: AgentProvider): Promise<CliLaunch | undefined> {
  if (provider === 'codex') return resolveCodexCli() as Promise<CodexCliLaunch | undefined>;
  if (provider === 'claude') return resolveClaudeCli();
  if (provider === 'cursor') return resolveCursorCli();
  if (provider === 'hermes') return resolveHermesCli();
  if (provider === 'kimi') return resolveKimiCli();
  return resolveCopilotCli();
}
