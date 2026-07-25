export type Effort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type Provider = 'codex' | 'claude' | 'cursor' | 'hermes' | 'copilot' | 'kimi';
export type PermissionRisk = 'safe' | 'caution' | 'danger';
export interface Selection {
  provider: Provider;
  modelId: string;
  effort?: Effort;
  fast?: boolean;
  permissionId?: string;
}
export interface InteractionResponse {
  selectedIds: string[];
  labels: string[];
  otherText?: string;
  submittedAt: string;
}
export interface AgentSnapshot {
  provider: Provider;
  providerLabel: string;
  modelId: string;
  modelLabel: string;
}
export interface ModelSwitchEvent {
  type: 'model-switch';
  from: AgentSnapshot;
  to: AgentSnapshot;
}
export interface FoldedConversationEvent {
  type: 'folded-conversation';
  foldedAt: string;
  messages: Message[];
}
export interface ReviewAction {
  snapshotId?: string;
  undoRequestedAt?: string;
  undoCompletedAt?: string;
  undoError?: string;
  redoSnapshotId?: string;
  redoRequestedAt?: string;
  redoCompletedAt?: string;
  redoError?: string;
}
export interface MessageReasoning {
  content: string;
  status: 'thinking' | 'complete';
  startedAt: string;
  completedAt?: string;
  placeholder?: boolean;
}
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  error?: boolean;
  interactionResponse?: InteractionResponse;
  reviewAction?: ReviewAction;
  reasoning?: MessageReasoning;
  agent?: AgentSnapshot;
  sessionEvent?: ModelSwitchEvent | FoldedConversationEvent;
  run?: {
    startedAt: string;
    completedAt?: string;
    durationMs?: number;
    status: 'running' | 'done' | 'error' | 'cancelled';
    responseCharacters?: number;
  };
}
export interface Options {
  providers: Array<{
    id: Provider;
    label: string;
    models: Array<{
      id: string;
      label: string;
      group?: string;
      description?: string;
      efforts: Effort[];
      defaultEffort?: Effort;
      supportsFast: boolean;
    }>;
    permissions: Array<{
      id: string;
      label: string;
      description: string;
      risk: PermissionRisk;
    }>;
    defaultPermissionId: string;
    modelsSource: 'live-cli' | 'fallback' | 'official-aliases' | 'local-cache';
    catalogUpdatedAt: string;
    capabilities: {
      supportsReasoningEffort: boolean;
      supportsFastMode: boolean;
      supportsWorkspace: boolean;
      supportsStreaming: boolean;
      setupCommand: string;
    };
    session: { connected: boolean; detail: string; version?: string };
  }>;
  defaults: Selection;
}
export type StreamEvent =
  | { type: 'run_started'; snapshotId?: string }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking'; text: string; delta?: boolean }
  | { type: 'turn_done' }
  | { type: 'error'; message: string };

export async function fetchOptions(forceRefresh = false): Promise<Options> {
  const response = await apiFetch(`/api/chat/options${forceRefresh ? '?refresh=1' : ''}`);
  if (!response.ok) throw new Error('Could not load Codex session status.');
  return response.json() as Promise<Options>;
}

export async function undoWorkspaceFiles(
  snapshotId: string,
  files: string[],
): Promise<{ restored: string[]; removed: string[]; skipped: string[]; redoSnapshotId: string }> {
  const response = await apiFetch('/api/chat/workspace-undo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ snapshotId, files }),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<{
    restored: string[];
    removed: string[];
    skipped: string[];
    redoSnapshotId: string;
  }>;
}

export async function redoWorkspaceFiles(
  snapshotId: string,
  files: string[],
): Promise<{ restored: string[]; removed: string[]; skipped: string[] }> {
  const response = await apiFetch('/api/chat/workspace-redo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ snapshotId, files }),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<{
    restored: string[];
    removed: string[];
    skipped: string[];
  }>;
}

export async function selectWorkingDirectory(): Promise<string | undefined> {
  const response = await apiFetch('/api/chat/select-directory', { method: 'POST' });
  if (!response.ok) throw new Error(await response.text());
  const body = await response.json() as { path?: unknown };
  return typeof body.path === 'string' && body.path.trim() ? body.path.trim() : undefined;
}

export async function streamChat(
  messages: Message[],
  selection: Selection,
  workingDirectory: string | undefined,
  additionalWorkingDirectories: string[] | undefined,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void,
  productivity?: { projectMemory?: string; contextFiles?: string[] },
): Promise<void> {
  const chatMessages = messages.filter(
    (message): message is Message & { role: 'user' | 'assistant' } =>
      message.role === 'user' || message.role === 'assistant',
  );
  const last = chatMessages.at(-1);
  if (!last || last.role !== 'user') throw new Error('The last message must be from the user.');
  const response = await apiFetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      history: chatMessages.slice(0, -1).map(({ role, content }) => ({ role, content })),
      message: last.content,
      selection,
      workingDirectory,
      additionalWorkingDirectories,
      projectMemory: productivity?.projectMemory,
      contextFiles: productivity?.contextFiles,
    }),
    signal,
  });
  if (!response.ok || !response.body) throw new Error(await response.text());

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const dispatch = (frame: string) => {
    const data = frame.split('\n').filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim()).join('\n');
    if (data) onEvent(JSON.parse(data) as StreamEvent);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf('\n\n');
    while (end >= 0) {
      dispatch(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
      end = buffer.indexOf('\n\n');
    }
  }
  if (buffer.trim()) dispatch(buffer);
}
import { apiFetch } from './apiClient';
