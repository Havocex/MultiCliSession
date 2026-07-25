import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';

const dataDir = process.env.CHAT_DATA_DIR
  ? path.resolve(process.env.CHAT_DATA_DIR)
  : path.resolve(process.cwd(), 'data');
const libraryPath = path.join(dataDir, 'chat-library.json');
const backupPath = path.join(dataDir, 'chat-library.backup.json');
let persistQueue = Promise.resolve();

function createDefaultLibrary() {
  const now = new Date().toISOString();
  const sessionId = randomUUID();
  const projectId = randomUUID();
  return {
    version: 1,
    revision: 0,
    activeProjectId: projectId,
    projects: [{
      id: projectId,
      name: 'My first project',
      createdAt: now,
      updatedAt: now,
      activeSessionId: sessionId,
      sessions: [{
        id: sessionId,
        title: 'New conversation',
        createdAt: now,
        updatedAt: now,
        messages: [],
      }],
    }],
  };
}

async function readLibrary(): Promise<unknown> {
  try {
    const parsed = JSON.parse(await readFile(libraryPath, 'utf8')) as Record<string, unknown>;
    return { ...parsed, revision: typeof parsed.revision === 'number' ? parsed.revision : 0 };
  } catch (error) {
    try {
      const backup = JSON.parse(await readFile(backupPath, 'utf8')) as Record<string, unknown>;
      return { ...backup, revision: typeof backup.revision === 'number' ? backup.revision : 0 };
    } catch {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const library = createDefaultLibrary();
    await persistLibrary(library);
    return library;
  }
}

async function persistLibrary(library: unknown): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const temporaryPath = `${libraryPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(library, null, 2), 'utf8');
  try {
    await copyFile(libraryPath, backupPath);
  } catch {
    // The first save has no previous library to back up.
  }
  await rename(temporaryPath, libraryPath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isMessage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    value.id.length <= 100 &&
    (value.role === 'user' || value.role === 'assistant' || value.role === 'system') &&
    typeof value.content === 'string' &&
    value.content.length <= 1_000_000
  );
}

function isSession(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.messages) || value.messages.length > 5_000) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    value.title.length <= 300 &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    value.messages.every(isMessage) &&
    (value.worktreePath === undefined || typeof value.worktreePath === 'string') &&
    (value.worktreeBranch === undefined || typeof value.worktreeBranch === 'string') &&
    (value.contextFiles === undefined ||
      (Array.isArray(value.contextFiles) && value.contextFiles.length <= 100 &&
        value.contextFiles.every((file) => typeof file === 'string'))) &&
    (value.pendingPrompts === undefined ||
      (Array.isArray(value.pendingPrompts) && value.pendingPrompts.length <= 100 &&
        value.pendingPrompts.every((prompt) =>
          typeof prompt === 'string' && prompt.length > 0 && prompt.length <= 100_000))) &&
    (value.plan === undefined ||
      (Array.isArray(value.plan) && value.plan.length <= 200 &&
        value.plan.every((item) => isRecord(item) && typeof item.id === 'string' &&
          typeof item.text === 'string' && item.text.length <= 1000 &&
          ['pending', 'running', 'blocked', 'done'].includes(String(item.status))))) &&
    (value.checkpoints === undefined ||
      (Array.isArray(value.checkpoints) && value.checkpoints.length <= 100 &&
        value.checkpoints.every((item) => isRecord(item) && typeof item.id === 'string' &&
          typeof item.label === 'string' && typeof item.createdAt === 'string' &&
          typeof item.messageCount === 'number')))
  );
}

function isProject(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.sessions) || value.sessions.length > 1_000) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    value.name.length <= 300 &&
    (value.workingDirectory === undefined || typeof value.workingDirectory === 'string') &&
    (value.additionalWorkingDirectories === undefined ||
      (Array.isArray(value.additionalWorkingDirectories) &&
        value.additionalWorkingDirectories.length <= 20 &&
        value.additionalWorkingDirectories.every((directory) =>
          typeof directory === 'string' && directory.length <= 2_000))) &&
    (value.memory === undefined || (typeof value.memory === 'string' && value.memory.length <= 12_000)) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    typeof value.activeSessionId === 'string' &&
    value.sessions.every(isSession)
  );
}

function isLibraryShape(value: unknown): value is {
  version: number;
  revision?: number;
  activeProjectId: string;
  projects: unknown[];
} {
  if (!isRecord(value)) return false;
  const candidate = value;
  return (
    candidate.version === 1 &&
    (candidate.revision === undefined ||
      (typeof candidate.revision === 'number' && Number.isSafeInteger(candidate.revision))) &&
    typeof candidate.activeProjectId === 'string' &&
    Array.isArray(candidate.projects) &&
    candidate.projects.length <= 100 &&
    (candidate.projects.length > 0 || candidate.activeProjectId === '') &&
    candidate.projects.every(isProject)
  );
}

export const libraryRouter = Router();

libraryRouter.get('/', async (_req, res) => {
  res.json(await readLibrary());
});

libraryRouter.put('/', async (req, res) => {
  if (!isLibraryShape(req.body)) {
    res.status(400).json({ error: 'Invalid chat library.' });
    return;
  }
  const serialized = JSON.stringify(req.body);
  if (Buffer.byteLength(serialized, 'utf8') > 10 * 1024 * 1024) {
    res.status(413).json({ error: 'Chat library is too large.' });
    return;
  }
  let result:
    | { status: 'saved'; revision: number }
    | { status: 'conflict'; revision: number }
    | undefined;
  persistQueue = persistQueue.catch(() => undefined).then(async () => {
    const current = await readLibrary() as { revision?: number };
    const currentRevision = current.revision ?? 0;
    const requestedRevision =
      typeof req.body.revision === 'number' ? req.body.revision : 0;
    if (requestedRevision !== currentRevision) {
      result = { status: 'conflict', revision: currentRevision };
      return;
    }
    const revision = currentRevision + 1;
    await persistLibrary({ ...req.body, revision });
    result = { status: 'saved', revision };
  });
  await persistQueue;
  if (result?.status === 'conflict') {
    res.status(409).json({
      error: 'The chat library changed in another window.',
      revision: result.revision,
    });
    return;
  }
  res.json({ ok: true, revision: result?.revision });
});
