import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildChatPrompt } from './chat-prompt.js';
import { resolveCodexCli, subscriptionEnv } from './codex-session.js';
import { configuredWorkspace, getProviderPermission } from './provider-permissions.js';
import { stopProcessTree } from './process-control.js';
import type { AgentEvent, AgentRunOptions } from './types.js';

function cleanError(value: unknown): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  try {
    const parsed = JSON.parse(raw) as { message?: string; error?: { message?: string } };
    return parsed.error?.message ?? parsed.message ?? raw;
  } catch {
    return raw;
  }
}

export async function runCodex(
  options: AgentRunOptions,
  emit: (event: AgentEvent) => void,
): Promise<void> {
  const launch = await resolveCodexCli();
  if (!launch) throw new Error('Codex CLI not found. Install @openai/codex and run `codex login`.');

  const permission = getProviderPermission('codex', options.selection.permissionId);
  const temporaryWorkspace = permission.workspaceAccess
    ? undefined
    : await mkdtemp(join(tmpdir(), 'standalone-chat-'));
  const workspace = temporaryWorkspace ?? options.workingDirectory ?? configuredWorkspace();
  let child: ReturnType<typeof spawn> | undefined;
  const stop = () => stopProcessTree(child);

  try {
    const args = [
      ...launch.prefixArgs,
      '-a', permission.codex!.approval,
      '-s', permission.codex!.sandbox,
      '-C', workspace,
      ...(permission.workspaceAccess
        ? [
            ...(options.additionalWorkingDirectories ?? []),
            ...new Set(
              (options.attachments ?? [])
                .map((attachment) => attachment.path)
                .filter((path): path is string => Boolean(path))
                .map((path) => dirname(path)),
            ),
          ].flatMap((directory) => ['--add-dir', directory])
        : []),
      '-m', options.selection.modelId,
      '--disable', 'apps',
      '--disable', 'browser_use',
      '--disable', 'computer_use',
      '--disable', 'image_generation',
      '--disable', 'multi_agent',
    ];
    if (options.selection.effort) {
      args.push('-c', `model_reasoning_effort='${options.selection.effort}'`);
    }
    if (options.selection.fast) args.push('-c', "service_tier='fast'");
    args.push(
      'exec',
      ...(options.attachments ?? [])
        .filter((attachment) => attachment.kind === 'image' && attachment.path)
        .flatMap((attachment) => ['--image', attachment.path!]),
      '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      '--skip-git-repo-check', '--color', 'never', buildChatPrompt(options),
    );

    await new Promise<void>((resolve, reject) => {
      child = spawn(launch.command, args, {
        cwd: workspace,
        env: subscriptionEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      options.signal.addEventListener('abort', stop, { once: true });
      let buffer = '';
      let stderr = '';

      const line = (raw: string) => {
        if (!raw.trim()) return;
        try {
          const event = JSON.parse(raw) as Record<string, unknown>;
          if (event.type === 'item.completed') {
            const item = event.item as { type?: string; text?: string };
            if (item?.type === 'agent_message' && item.text) {
              emit({ type: 'text_delta', text: item.text });
            } else if (item?.type === 'reasoning' && item.text) {
              emit({ type: 'thinking', text: item.text, delta: false });
            }
          } else if (event.type === 'error') {
            emit({ type: 'error', message: cleanError(event.message) });
          }
        } catch {
          // stdout is expected to be JSONL; ignore unrelated diagnostics.
        }
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          line(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf('\n');
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) => {
        if (buffer.trim()) line(buffer);
        if (!options.signal.aborted && code) reject(new Error(stderr.trim() || `Codex exited with ${code}.`));
        else resolve();
      });
    });
  } finally {
    options.signal.removeEventListener('abort', stop);
    if (temporaryWorkspace) await rm(temporaryWorkspace, { recursive: true, force: true });
  }
}
