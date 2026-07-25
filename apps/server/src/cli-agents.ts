import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildChatPrompt } from './chat-prompt.js';
import {
  configuredWorkspace,
  cursorSandboxForPlatform,
  getProviderPermission,
} from './provider-permissions.js';
import { resolveProviderCli } from './provider-sessions.js';
import { normalizeSnapshot } from './stream-normalizer.js';
import { stopProcessTree } from './process-control.js';
import type { AgentEvent, AgentRunOptions } from './types.js';

export function parseCopilotStreamEvent(
  event: Record<string, unknown>,
  snapshot: string,
): { snapshot: string; events: AgentEvent[] } {
  const type = String(event.type ?? '');
  const data = event.data && typeof event.data === 'object'
    ? event.data as Record<string, unknown>
    : undefined;

  if (type === 'assistant.message_delta' && typeof data?.deltaContent === 'string') {
    return {
      snapshot: snapshot + data.deltaContent,
      events: data.deltaContent
        ? [{ type: 'text_delta', text: data.deltaContent }]
        : [],
    };
  }

  if (type === 'assistant.message' && typeof data?.content === 'string') {
    const normalized = normalizeSnapshot(data.content, snapshot);
    return {
      snapshot: normalized.next,
      events: normalized.delta
        ? [{ type: 'text_delta', text: normalized.delta }]
        : [],
    };
  }

  if (type === 'assistant.reasoning' && typeof data?.content === 'string' && data.content) {
    return {
      snapshot,
      events: [{ type: 'thinking', text: data.content, delta: false }],
    };
  }

  return { snapshot, events: [] };
}

export async function runSubscriptionAgent(
  options: AgentRunOptions,
  emit: (event: AgentEvent) => void,
): Promise<void> {
  const launch = await resolveProviderCli(options.selection.provider);
  if (!launch) throw new Error(`${options.selection.provider} CLI was not found.`);
  const permission = getProviderPermission(
    options.selection.provider,
    options.selection.permissionId,
  );
  const temporaryWorkspace = permission.workspaceAccess
    ? undefined
    : await mkdtemp(join(tmpdir(), `standalone-${options.selection.provider}-`));
  const workspace = temporaryWorkspace ?? options.workingDirectory ?? configuredWorkspace();
  let child: ReturnType<typeof spawn> | undefined;
  const stop = () => stopProcessTree(child);

  try {
    const prompt = buildChatPrompt(options);
    const additionalDirectories = permission.workspaceAccess
      ? [
          ...(options.additionalWorkingDirectories ?? []),
          ...new Set(
            (options.attachments ?? [])
              .map((attachment) => attachment.path)
              .filter((path): path is string => Boolean(path))
              .map((path) => dirname(path)),
          ),
        ]
      : [];
    const hermesModel = options.selection.provider === 'hermes'
      ? options.selection.modelId.split('::', 2)
      : undefined;
    const args = options.selection.provider === 'claude'
      ? [
          ...launch.prefixArgs, '-p', '--verbose', '--output-format', 'stream-json',
          '--include-partial-messages', '--no-session-persistence', '--permission-mode',
          permission.claude!.mode, '--tools', permission.claude!.tools,
          '--strict-mcp-config',
          ...(permission.claude!.mode === 'bypassPermissions'
            ? ['--dangerously-skip-permissions']
            : []),
          ...additionalDirectories.flatMap((directory) => ['--add-dir', directory]),
          '--model', options.selection.modelId,
          ...(options.selection.effort ? ['--effort', options.selection.effort] : []),
          prompt,
        ]
      : options.selection.provider === 'cursor'
      ? [
          ...launch.prefixArgs, '-p', '--trust',
          '--sandbox', cursorSandboxForPlatform(permission.cursor!.sandbox),
          ...(permission.cursor!.mode ? ['--mode', permission.cursor!.mode] : []),
          ...(permission.cursor!.autoReview ? ['--auto-review'] : []),
          ...(permission.cursor!.force ? ['--force'] : []),
          '--output-format', 'stream-json',
          '--stream-partial-output', '--workspace', workspace, '--model',
          options.selection.modelId,
          ...additionalDirectories.flatMap((directory) => ['--add-dir', directory]),
          prompt,
        ]
      : options.selection.provider === 'hermes'
      ? [
          ...launch.prefixArgs,
          ...(permission.hermes!.safeMode ? ['--safe-mode'] : ['--ignore-rules']),
          ...(!permission.hermes!.tools ? ['--toolsets', ''] : []),
          ...(permission.hermes!.yolo ? ['--yolo'] : []),
          ...(hermesModel?.[0] && hermesModel[1] ? ['--provider', hermesModel[0]] : []),
          '--model', hermesModel?.[1] ?? options.selection.modelId,
          '--oneshot', prompt,
        ]
      : options.selection.provider === 'kimi'
      ? [
          ...launch.prefixArgs,
          '-m', options.selection.modelId,
          '-p', prompt,
          '--output-format', 'stream-json',
          ...additionalDirectories.flatMap((directory) => ['--add-dir', directory]),
        ]
      : [
          ...launch.prefixArgs, '-p', prompt,
          '--model', options.selection.modelId,
          '--output-format', 'json', '--stream', 'on',
          '--no-remote', '--no-remote-export', '--no-custom-instructions',
          '-C', workspace,
          ...additionalDirectories.flatMap((directory) => ['--add-dir', directory]),
          ...(options.selection.effort ? ['--reasoning-effort', options.selection.effort] : []),
          ...(permission.copilot!.allowAll ? ['--allow-all'] : []),
          ...(permission.copilot!.availableTools !== undefined
            ? [`--available-tools=${permission.copilot!.availableTools}`]
            : []),
          ...(permission.copilot!.allowTools ?? []).flatMap((tool) => [`--allow-tool=${tool}`]),
        ];

    await new Promise<void>((resolve, reject) => {
      child = spawn(launch.command, args, {
        cwd: workspace,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: '',
          CLAUDE_CODE_OAUTH_TOKEN: '',
          CURSOR_API_KEY: '',
          NO_OPEN_BROWSER: '1',
          CURSOR_INVOKED_AS: 'agent',
        },
        windowsHide: true,
      });
      options.signal.addEventListener('abort', stop, { once: true });
      let buffer = '';
      let stderr = '';
      let emittedText = false;
      let cursorSnapshot = '';
      let copilotSnapshot = '';
      let kimiSnapshot = '';
      const emitSnapshot = (text: string, previous: string): string => {
        const { next, delta } = normalizeSnapshot(text, previous);
        if (delta) {
          emittedText = true;
          emit({ type: 'text_delta', text: delta });
        }
        return next;
      };
      const handle = (raw: string) => {
        try {
          const event = JSON.parse(raw) as Record<string, unknown>;
          if (options.selection.provider === 'claude' && event.type === 'stream_event') {
            const stream = event.event as { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
            if (stream?.type === 'content_block_delta' && stream.delta?.type === 'text_delta' && stream.delta.text) {
              emittedText = true;
              emit({ type: 'text_delta', text: stream.delta.text });
            } else if (stream?.delta?.thinking) {
              emit({ type: 'thinking', text: stream.delta.thinking, delta: true });
            }
          } else if (options.selection.provider === 'cursor' && event.type === 'assistant') {
            const message = event.message as { content?: Array<{ type?: string; text?: string }> };
            const text = (message?.content ?? [])
              .filter((block) => block.type === 'text' && block.text)
              .map((block) => block.text)
              .join('');
            cursorSnapshot = emitSnapshot(text, cursorSnapshot);
          } else if (options.selection.provider === 'copilot') {
            const parsed = parseCopilotStreamEvent(event, copilotSnapshot);
            copilotSnapshot = parsed.snapshot;
            for (const parsedEvent of parsed.events) {
              if (parsedEvent.type === 'text_delta') {
                emittedText = true;
              }
              emit(parsedEvent);
            }
          } else if (options.selection.provider === 'kimi') {
            const message = event.message && typeof event.message === 'object'
              ? event.message as Record<string, unknown>
              : event;
            const role = String(message.role ?? event.role ?? '');
            const content = message.content ?? event.content;
            const text = typeof content === 'string'
              ? content
              : Array.isArray(content)
                ? content.flatMap((part) =>
                    part && typeof part === 'object' &&
                    typeof (part as Record<string, unknown>).text === 'string'
                      ? [(part as Record<string, unknown>).text as string]
                      : [],
                  ).join('')
                : '';
            if ((!role || role === 'assistant') && text) {
              kimiSnapshot = emitSnapshot(text, kimiSnapshot);
            }
          } else if (event.type === 'thinking' && typeof event.text === 'string') {
            emit({ type: 'thinking', text: event.text, delta: true });
          } else if (event.type === 'result' && event.is_error) {
            emit({ type: 'error', message: String(event.result ?? 'Agent run failed.') });
          }
        } catch {
          // Ignore non-JSON diagnostics.
        }
      };
      child.stdout?.on('data', (chunk: Buffer) => {
        if (options.selection.provider === 'hermes') {
          const text = chunk.toString('utf8');
          if (text) {
            emittedText = true;
            emit({ type: 'text_delta', text });
          }
          return;
        }
        buffer += chunk.toString('utf8');
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          handle(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf('\n');
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) => {
        if (buffer.trim()) handle(buffer);
        if (!options.signal.aborted && code) reject(new Error(stderr.trim() || `Agent exited with ${code}.`));
        else if (!options.signal.aborted && !emittedText && stderr.trim()) reject(new Error(stderr.trim()));
        else resolve();
      });
    });
  } finally {
    options.signal.removeEventListener('abort', stop);
    if (temporaryWorkspace) await rm(temporaryWorkspace, { recursive: true, force: true });
  }
}
