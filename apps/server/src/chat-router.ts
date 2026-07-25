import { Router } from 'express';
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { runCodex } from './codex-agent.js';
import { materializeChatAttachments } from './chat-attachments.js';
import { runSubscriptionAgent } from './cli-agents.js';
import { getProviderModelCatalog, listProviderModels } from './provider-models.js';
import { providerDefinitions } from './provider-capabilities.js';
import { getProviderPermission, listProviderPermissions } from './provider-permissions.js';
import { configuredWorkspace } from './provider-permissions.js';
import { getProviderStatus } from './provider-sessions.js';
import {
  createWorkspaceRedoSnapshot,
  createWorkspaceSnapshot,
  getWorkspaceSnapshotFile,
  restoreWorkspaceFiles,
} from './workspace-snapshots.js';
import type { AgentEvent, AgentProvider, AgentSelection, ChatMessage } from './types.js';

export const chatRouter = Router();
const execFileAsync = promisify(execFile);
let optionsCache: { expiresAt: number; value: unknown } | undefined;

function boundedHistory(history: ChatMessage[]): ChatMessage[] {
  const maximumCharacters = 24_000;
  const selected: ChatMessage[] = [];
  let characters = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]!;
    const remaining = maximumCharacters - characters;
    if (remaining <= 0) break;
    const content =
      message.content.length <= remaining
        ? message.content
        : message.content.slice(message.content.length - remaining);
    selected.push({ ...message, content });
    characters += content.length;
  }
  return selected.reverse();
}

chatRouter.get('/workspace-diff', async (req, res) => {
  const requestedRoot = typeof req.query.path === 'string' ? req.query.path.trim() : '';
  const requestedFile = typeof req.query.file === 'string' ? req.query.file.trim() : '';
  const snapshotId = typeof req.query.snapshotId === 'string' ? req.query.snapshotId.trim() : '';
  const status = typeof req.query.status === 'string' ? req.query.status : 'modified';
  if (!requestedRoot || !requestedFile) {
    res.status(400).json({ error: 'A workspace path and file are required.' });
    return;
  }
  const root = resolve(requestedRoot);
  const absolute = resolve(root, requestedFile);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    res.status(400).json({ error: 'The requested file is outside the project workspace.' });
    return;
  }
  let patch = '';
  if (snapshotId) {
    try {
      const snapshot = await getWorkspaceSnapshotFile(snapshotId, requestedFile);
      if (resolve(snapshot.workspace) !== root) {
        res.status(400).json({ error: 'The snapshot does not belong to this workspace.' });
        return;
      }
      if (snapshot.state === 'captured') {
        try {
          const result = await execFileAsync('git', [
            'diff', '--no-index', '--no-ext-diff', '--unified=4', '--',
            snapshot.path!, absolute,
          ], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
          patch = result.stdout;
        } catch (error) {
          patch = (error as { stdout?: string }).stdout ?? '';
          if (!patch) {
            patch = (snapshot.content ?? '').split('\n').map((line) => `-${line}`).join('\n');
          }
        }
      } else if (snapshot.state === 'absent' && status !== 'deleted') {
        try {
          const content = await readFile(absolute, 'utf8');
          patch = content.split('\n').map((line) => `+${line}`).join('\n');
        } catch {
          patch = '';
        }
      }
    } catch {
      // A pruned or incomplete snapshot falls back to the Git working-tree diff.
    }
  }
  if (!patch) {
    try {
      const result = await execFileAsync('git', [
        '-C', root, 'diff', '--no-ext-diff', '--unified=4', '--', requestedFile,
      ], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
      patch = result.stdout;
    } catch (error) {
      patch = (error as { stdout?: string }).stdout ?? '';
    }
  }
  if (!patch && status !== 'deleted') {
    try {
      const content = await readFile(absolute, 'utf8');
      const prefix = status === 'added' ? '+' : ' ';
      patch = content.split('\n').map((line) => `${prefix}${line}`).join('\n');
    } catch {
      patch = '';
    }
  }
  const lines = patch
    .split('\n')
    .filter((line) => !line.startsWith('diff --git') && !line.startsWith('index ') &&
      !line.startsWith('--- ') && !line.startsWith('+++ ') && !line.startsWith('@@'))
    .slice(0, 5000)
    .map((line) => ({
      type: line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : 'context',
      content: /^[ +\-]/.test(line) ? line.slice(1) : line,
    }));
  res.json({ file: requestedFile, lines });
});

chatRouter.get('/workspace-artifacts', async (req, res) => {
  const requested = typeof req.query.path === 'string' ? req.query.path.trim() : '';
  if (!requested) {
    res.json({ artifacts: [] });
    return;
  }
  const root = resolve(requested);
  try {
    if (!(await stat(root)).isDirectory()) throw new Error('not a directory');
    const files: Array<{ path: string; title: string; kind: 'Markdown' | 'Plan'; content: string; updatedAt: string }> = [];
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > 4 || files.length >= 100) return;
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (files.length >= 100) break;
        if (entry.isDirectory()) {
          if (!['node_modules', '.git', 'dist', 'build'].includes(entry.name)) {
            await visit(join(directory, entry.name), depth + 1);
          }
          continue;
        }
        if (!entry.isFile() || !/\.md(?:own)?$/i.test(entry.name)) continue;
        const absolute = join(directory, entry.name);
        const details = await stat(absolute);
        if (details.size > 512 * 1024) continue;
        const filePath = relative(root, absolute).replaceAll('\\', '/');
        files.push({
          path: filePath,
          title: entry.name,
          kind: /(?:^|[-_.])plan(?:[-_.]|$)/i.test(entry.name) ? 'Plan' : 'Markdown',
          content: await readFile(absolute, 'utf8'),
          updatedAt: details.mtime.toISOString(),
        });
      }
    };
    await visit(root, 0);
    files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    res.json({ artifacts: files });
  } catch {
    res.status(400).json({ error: `Could not read project working directory: ${root}` });
  }
});

chatRouter.post('/workspace-file', async (req, res) => {
  const roots: string[] = Array.isArray(req.body?.roots)
    ? req.body.roots
        .filter((value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()))
        .slice(0, 20)
        .map((value: string) => resolve(value.trim()))
    : [];
  const requestedFile = typeof req.body?.file === 'string' ? req.body.file.trim() : '';
  if (!roots.length || !requestedFile) {
    res.status(400).json({ error: 'Workspace roots and a file are required.' });
    return;
  }
  const candidates: string[] = isAbsolute(requestedFile)
    ? [resolve(requestedFile)]
    : roots.map((root) => resolve(root, requestedFile));
  for (const absolute of candidates) {
    const root = roots.find((candidate) =>
      absolute === candidate || absolute.startsWith(`${candidate}${sep}`),
    );
    if (!root) continue;
    try {
      const details = await stat(absolute);
      if (!details.isFile() || details.size > 2 * 1024 * 1024) continue;
      const content = await readFile(absolute, 'utf8');
      res.json({
        path: relative(root, absolute).replaceAll('\\', '/'),
        root,
        content,
      });
      return;
    } catch {
      // Try the same relative path under the next configured root.
    }
  }
  res.status(404).json({ error: 'The referenced file was not found in the project folders.' });
});

chatRouter.post('/workspace-undo', async (req, res) => {
  const snapshotId = typeof req.body?.snapshotId === 'string' ? req.body.snapshotId : '';
  const files = Array.isArray(req.body?.files)
    ? req.body.files.filter((value: unknown): value is string => typeof value === 'string')
    : [];
  if (!snapshotId || !files.length) {
    res.status(400).json({ error: 'A snapshot and at least one file are required.' });
    return;
  }
  try {
    const redoSnapshotId = await createWorkspaceRedoSnapshot(snapshotId);
    res.json({
      ...await restoreWorkspaceFiles(snapshotId, files),
      redoSnapshotId,
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Could not restore workspace files.',
    });
  }
});

chatRouter.post('/workspace-redo', async (req, res) => {
  const snapshotId = typeof req.body?.snapshotId === 'string' ? req.body.snapshotId : '';
  const files = Array.isArray(req.body?.files)
    ? req.body.files.filter((value: unknown): value is string => typeof value === 'string')
    : [];
  if (!snapshotId || !files.length) {
    res.status(400).json({ error: 'A redo snapshot and at least one file are required.' });
    return;
  }
  try {
    res.json(await restoreWorkspaceFiles(snapshotId, files));
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Could not reapply workspace files.',
    });
  }
});

chatRouter.post('/select-directory', async (_req, res) => {
  if (process.platform !== 'win32') {
    res.status(501).json({ error: 'The native folder picker is currently available on Windows.' });
    return;
  }
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$dialog.Description = 'Choose a working directory for this project'",
    '$dialog.ShowNewFolderButton = $true',
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
    '  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '  Write-Output $dialog.SelectedPath',
    '}',
  ].join('; ');
  try {
    const result = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-STA', '-Command', script],
      { windowsHide: false, timeout: 120_000, maxBuffer: 64 * 1024 },
    );
    const selectedPath = result.stdout.trim();
    res.json({ path: selectedPath || null });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ETIMEDOUT') {
      res.status(408).json({ error: 'The folder picker timed out.' });
      return;
    }
    res.json({ path: null });
  }
});

chatRouter.get('/options', async (req, res) => {
  const forceRefresh = req.query.refresh === '1';
  if (!forceRefresh && optionsCache && optionsCache.expiresAt > Date.now()) {
    res.json(optionsCache.value);
    return;
  }
  const providers = await Promise.all(
    providerDefinitions.map(async (provider) => {
      const [session, catalog] = await Promise.all([
        getProviderStatus(provider.id),
        getProviderModelCatalog(provider.id),
      ]);
      return {
        ...provider,
        session,
        models: catalog.models,
        permissions: listProviderPermissions(provider.id),
        defaultPermissionId: getProviderPermission(provider.id).id,
        modelsSource: catalog.source,
        catalogUpdatedAt: new Date().toISOString(),
      };
    }),
  );
  const codex = providers.find((provider) => provider.id === 'codex')!;
  const value = {
    providers,
    defaults: {
      provider: 'codex',
      modelId: codex.models[0]?.id ?? 'gpt-5.6-sol',
      effort: codex.models[0]?.defaultEffort ?? 'medium',
      fast: false,
      permissionId: codex.defaultPermissionId,
    },
  };
  optionsCache = { value, expiresAt: Date.now() + 30_000 };
  res.json(value);
});

chatRouter.post('/', async (req, res) => {
  const body = req.body as {
    history?: unknown;
    message?: unknown;
    selection?: Partial<AgentSelection>;
    workingDirectory?: unknown;
    additionalWorkingDirectories?: unknown;
    projectMemory?: unknown;
    contextFiles?: unknown;
    attachments?: unknown;
  };
  if (typeof body?.message !== 'string' || !body.message.trim()) {
    res.status(400).json({ error: 'A non-empty message is required.' });
    return;
  }
  if (body.message.length > 100_000) {
    res.status(413).json({ error: 'The message is too large.' });
    return;
  }
  const rawHistory = Array.isArray(body.history)
    ? body.history.filter(
        (item): item is ChatMessage =>
          item && typeof item === 'object' &&
          ((item as ChatMessage).role === 'user' || (item as ChatMessage).role === 'assistant') &&
          typeof (item as ChatMessage).content === 'string',
      ).slice(-40)
    : [];
  const history = boundedHistory(
    rawHistory.map(({ role, content }) => ({ role, content })),
  );
  const requestedProvider = body.selection?.provider;
  const provider: AgentProvider =
    requestedProvider === 'claude' || requestedProvider === 'cursor' ||
    requestedProvider === 'hermes' || requestedProvider === 'copilot' ||
    requestedProvider === 'kimi'
      ? requestedProvider
      : 'codex';
  const providerModels = await listProviderModels(provider);
  const requestedModelId =
    typeof body.selection?.modelId === 'string' ? body.selection.modelId : undefined;
  const model =
    providerModels.find((item) => item.id === requestedModelId) ?? providerModels[0];
  if (!model) {
    res.status(503).json({ error: `No models are available for ${provider}.` });
    return;
  }
  const selection: AgentSelection = {
    provider,
    modelId: model.id,
    effort:
      body.selection?.effort && model.efforts.includes(body.selection.effort)
        ? body.selection.effort
        : model.defaultEffort,
    fast: model.supportsFast ? Boolean(body.selection?.fast) : false,
    permissionId: getProviderPermission(
      provider,
      typeof body.selection?.permissionId === 'string' ? body.selection.permissionId : undefined,
    ).id,
  };
  let workingDirectory: string | undefined;
  if (typeof body.workingDirectory === 'string' && body.workingDirectory.trim()) {
    workingDirectory = resolve(body.workingDirectory.trim());
    try {
      const details = await stat(workingDirectory);
      if (!details.isDirectory()) throw new Error('not a directory');
    } catch {
      res.status(400).json({
        error: `The project working directory does not exist or is not a folder: ${workingDirectory}`,
      });
      return;
    }
  }
  const additionalWorkingDirectories: string[] = [];
  if (Array.isArray(body.additionalWorkingDirectories)) {
    for (const candidate of body.additionalWorkingDirectories.slice(0, 20)) {
      if (typeof candidate !== 'string' || !candidate.trim()) continue;
      const directory = resolve(candidate.trim());
      if (directory === workingDirectory || additionalWorkingDirectories.includes(directory)) continue;
      try {
        const details = await stat(directory);
        if (!details.isDirectory()) throw new Error('not a directory');
      } catch {
        res.status(400).json({
          error: `An additional project directory does not exist or is not a folder: ${directory}`,
        });
        return;
      }
      additionalWorkingDirectories.push(directory);
    }
  }
  const permission = getProviderPermission(provider, selection.permissionId);
  const projectMemory =
    typeof body.projectMemory === 'string' ? body.projectMemory.slice(0, 12_000) : undefined;
  const requestedContextFiles = Array.isArray(body.contextFiles)
    ? body.contextFiles.filter((value): value is string => typeof value === 'string').slice(0, 20)
    : [];
  const contextFiles: Array<{ path: string; content: string }> = [];
  if (workingDirectory && permission.workspaceAccess) {
    let remainingCharacters = 80_000;
    for (const file of requestedContextFiles) {
      const absolute = resolve(workingDirectory, file);
      if (absolute !== workingDirectory && !absolute.startsWith(`${workingDirectory}${sep}`)) continue;
      try {
        const content = await readFile(absolute, 'utf8');
        const selected = content.slice(0, remainingCharacters);
        contextFiles.push({ path: file, content: selected });
        remainingCharacters -= selected.length;
        if (remainingCharacters <= 0) break;
      } catch {
        // A selected file may have been renamed between selection and send.
      }
    }
  }
  const snapshotId = permission.workspaceAccess
    ? await createWorkspaceSnapshot(workingDirectory ?? configuredWorkspace())
    : undefined;
  const currentAttachments = Array.isArray(body.attachments) ? body.attachments : [];
  const historicalAttachments = rawHistory
    .slice()
    .reverse()
    .flatMap((message) => Array.isArray(message.attachments) ? message.attachments : []);
  let attachmentBundle;
  try {
    attachmentBundle = await materializeChatAttachments([
      ...currentAttachments,
      ...historicalAttachments,
    ]);
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Could not prepare the attachments.',
    });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const controller = new AbortController();
  req.on('close', () => controller.abort());
  const maximumRunMs = Math.max(
    60_000,
    Number(process.env.CHAT_RUN_TIMEOUT_MS) || 15 * 60_000,
  );
  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, maximumRunMs);
  watchdog.unref();
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': heartbeat\n\n');
  }, 15_000);
  heartbeat.unref();
  const send = (event: AgentEvent) => {
    if (!res.writableEnded) {
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };
  send({ type: 'run_started', snapshotId });

  try {
    const run = provider === 'codex' ? runCodex : runSubscriptionAgent;
    await run({
      history,
      message: body.message.trim(),
      workingDirectory,
      additionalWorkingDirectories,
      selection,
      signal: controller.signal,
      projectMemory,
      contextFiles,
      attachments: attachmentBundle.attachments,
    }, send);
    if (timedOut) {
      send({
        type: 'error',
        message: `The provider did not finish within ${Math.round(maximumRunMs / 60_000)} minutes and was stopped.`,
      });
    } else if (!controller.signal.aborted) {
      send({ type: 'turn_done' });
    }
  } catch (error) {
    send({
      type: 'error',
      message: timedOut
        ? `The provider did not finish within ${Math.round(maximumRunMs / 60_000)} minutes and was stopped.`
        : error instanceof Error ? error.message : String(error),
    });
  } finally {
    await attachmentBundle.cleanup().catch(() => undefined);
    clearTimeout(watchdog);
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
});
