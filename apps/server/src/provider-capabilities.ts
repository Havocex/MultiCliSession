import type { AgentProvider } from './types.js';

export interface ProviderCapabilities {
  supportsReasoningEffort: boolean;
  supportsFastMode: boolean;
  supportsWorkspace: boolean;
  supportsStreaming: boolean;
  setupCommand: string;
}

export const providerDefinitions: Array<{
  id: AgentProvider;
  label: string;
  capabilities: ProviderCapabilities;
}> = [
  {
    id: 'codex',
    label: 'Codex',
    capabilities: {
      supportsReasoningEffort: true,
      supportsFastMode: true,
      supportsWorkspace: true,
      supportsStreaming: true,
      setupCommand: 'codex login',
    },
  },
  {
    id: 'claude',
    label: 'Claude',
    capabilities: {
      supportsReasoningEffort: true,
      supportsFastMode: false,
      supportsWorkspace: true,
      supportsStreaming: true,
      setupCommand: 'claude login',
    },
  },
  {
    id: 'cursor',
    label: 'Cursor',
    capabilities: {
      supportsReasoningEffort: false,
      supportsFastMode: true,
      supportsWorkspace: true,
      supportsStreaming: true,
      setupCommand: 'agent login',
    },
  },
  {
    id: 'hermes',
    label: 'Hermes',
    capabilities: {
      supportsReasoningEffort: false,
      supportsFastMode: false,
      supportsWorkspace: true,
      supportsStreaming: true,
      setupCommand: 'hermes login',
    },
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    capabilities: {
      supportsReasoningEffort: true,
      supportsFastMode: true,
      supportsWorkspace: true,
      supportsStreaming: true,
      setupCommand: 'copilot login',
    },
  },
  {
    id: 'kimi',
    label: 'Kimi',
    capabilities: {
      supportsReasoningEffort: false,
      supportsFastMode: false,
      supportsWorkspace: true,
      supportsStreaming: true,
      setupCommand: 'kimi login',
    },
  },
];
