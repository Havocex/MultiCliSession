export type AgentEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type AgentProvider = 'codex' | 'claude' | 'cursor' | 'hermes' | 'copilot' | 'kimi';

export interface AgentSelection {
  provider: AgentProvider;
  modelId: string;
  effort?: AgentEffort;
  fast?: boolean;
  permissionId?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type AgentEvent =
  | { type: 'run_started'; snapshotId?: string }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking'; text: string; delta?: boolean }
  | { type: 'turn_done' }
  | { type: 'error'; message: string };

export interface AgentRunOptions {
  history: ChatMessage[];
  message: string;
  workingDirectory?: string;
  additionalWorkingDirectories?: string[];
  selection: AgentSelection;
  signal: AbortSignal;
  projectMemory?: string;
  contextFiles?: Array<{ path: string; content: string }>;
}
