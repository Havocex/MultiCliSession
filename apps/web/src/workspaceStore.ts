import type { Message, Selection } from './chatClient';
import { apiFetch } from './apiClient';

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  selection?: Selection;
  messages: Message[];
  worktreePath?: string;
  worktreeBranch?: string;
  contextFiles?: string[];
  plan?: PlanItem[];
  checkpoints?: ChatCheckpoint[];
  /** Prompts waiting behind the active run. Persisted so refreshes do not lose work. */
  pendingPrompts?: string[];
}

export interface PlanItem {
  id: string;
  text: string;
  status: 'pending' | 'running' | 'blocked' | 'done';
}

export interface ChatCheckpoint {
  id: string;
  label: string;
  createdAt: string;
  messageCount: number;
}

export interface ChatProject {
  id: string;
  name: string;
  workingDirectory?: string;
  additionalWorkingDirectories?: string[];
  createdAt: string;
  updatedAt: string;
  activeSessionId: string;
  sessions: ChatSession[];
  memory?: string;
}

export interface ChatLibrary {
  version: 1;
  revision?: number;
  activeProjectId: string;
  projects: ChatProject[];
}

export class LibraryConflictError extends Error {
  constructor() {
    super('The history changed in another window.');
    this.name = 'LibraryConflictError';
  }
}

export function mergeChatLibraries(
  remote: ChatLibrary,
  local: ChatLibrary,
): ChatLibrary {
  const localProjects = new Map(local.projects.map((project) => [project.id, project]));
  const projects = remote.projects.map((remoteProject) => {
    const localProject = localProjects.get(remoteProject.id);
    if (!localProject) return remoteProject;
    localProjects.delete(remoteProject.id);
    const localSessions = new Map(localProject.sessions.map((session) => [session.id, session]));
    const sessions = remoteProject.sessions.map((remoteSession) => {
      const localSession = localSessions.get(remoteSession.id);
      if (!localSession) return remoteSession;
      localSessions.delete(remoteSession.id);
      const localMessages = new Map(localSession.messages.map((message) => [message.id, message]));
      const messages = remoteSession.messages.map((message) => {
        const localMessage = localMessages.get(message.id);
        localMessages.delete(message.id);
        return localMessage ?? message;
      });
      return {
        ...remoteSession,
        ...localSession,
        messages: [...messages, ...localMessages.values()],
      };
    });
    return {
      ...remoteProject,
      ...localProject,
      sessions: [...sessions, ...localSessions.values()],
    };
  });
  return {
    ...remote,
    ...local,
    revision: remote.revision,
    projects: [...projects, ...localProjects.values()],
  };
}

export async function fetchLibrary(): Promise<ChatLibrary> {
  const response = await apiFetch('/api/library');
  if (!response.ok) throw new Error('Could not load projects and chat history.');
  return response.json() as Promise<ChatLibrary>;
}

export async function saveLibrary(
  library: ChatLibrary,
  revision = library.revision ?? 0,
): Promise<number> {
  const response = await apiFetch('/api/library', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...library, revision }),
  });
  if (!response.ok) {
    if (response.status === 409) {
      throw new LibraryConflictError();
    }
    throw new Error('Could not save chat history.');
  }
  const body = await response.json() as { revision?: unknown };
  return typeof body.revision === 'number' ? body.revision : revision;
}

export function makeSession(selection?: Selection): ChatSession {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: 'New conversation',
    createdAt: now,
    updatedAt: now,
    selection,
    messages: [],
  };
}

export function makeProject(index: number, selection?: Selection): ChatProject {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: `Project ${index}`,
    workingDirectory: '',
    additionalWorkingDirectories: [],
    createdAt: now,
    updatedAt: now,
    activeSessionId: '',
    sessions: [],
  };
}
