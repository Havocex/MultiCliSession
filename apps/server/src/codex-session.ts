import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export interface CodexCliLaunch {
  command: string;
  prefixArgs: string[];
  displayPath: string;
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCodexCli(): Promise<CodexCliLaunch | undefined> {
  const override = process.env.CODEX_CLI_PATH?.trim();
  if (override && (await exists(override))) {
    return override.endsWith('.js')
      ? { command: process.execPath, prefixArgs: [override], displayPath: override }
      : { command: override, prefixArgs: [], displayPath: override };
  }

  const candidates =
    process.platform === 'win32'
      ? [
          path.join(process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'), 'npm',
            'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
          path.join(homedir(), '.local', 'bin', 'codex.exe'),
        ]
      : [
          path.join(homedir(), '.local', 'bin', 'codex'),
          '/usr/local/bin/codex',
          '/usr/bin/codex',
        ];

  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return candidate.endsWith('.js')
        ? { command: process.execPath, prefixArgs: [candidate], displayPath: candidate }
        : { command: candidate, prefixArgs: [], displayPath: candidate };
    }
  }
  return undefined;
}

export function subscriptionEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
    'AZURE_OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_ORG_ID',
    'OPENAI_ORGANIZATION',
    'OPENAI_PROJECT_ID',
  ]) delete env[key];
  return env;
}

export function runCodexCapture(
  launch: CodexCliLaunch,
  args: string[],
  options?: { timeoutMs?: number },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(launch.command, [...launch.prefixArgs, ...args], {
      env: subscriptionEnv(),
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), options?.timeoutMs ?? 20_000);
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export async function getCodexStatus(): Promise<{
  connected: boolean;
  detail: string;
  version?: string;
}> {
  const launch = await resolveCodexCli();
  if (!launch) {
    return { connected: false, detail: 'Codex CLI was not found.' };
  }

  const [statusResult, versionResult] = await Promise.all([
    runCodexCapture(launch, ['login', 'status']),
    runCodexCapture(launch, ['--version']),
  ]);
  const status = `${statusResult.stdout}\n${statusResult.stderr}`.trim();
  const version = `${versionResult.stdout}\n${versionResult.stderr}`.trim();
  const connected = /logged in using chatgpt/i.test(status);
  return {
    connected,
    detail: connected
      ? 'Connected through your ChatGPT subscription.'
      : 'Run `codex login` and choose Sign in with ChatGPT.',
    version: version || undefined,
  };
}
