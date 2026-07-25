import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentProvider } from './types.js';

export type PermissionRisk = 'safe' | 'caution' | 'danger';

export interface ProviderPermissionOption {
  id: string;
  label: string;
  description: string;
  risk: PermissionRisk;
}

interface ProviderPermissionRuntime extends ProviderPermissionOption {
  workspaceAccess: boolean;
  codex?: {
    sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
    approval: 'untrusted' | 'on-request' | 'never';
  };
  claude?: {
    mode: 'dontAsk' | 'plan' | 'acceptEdits' | 'auto' | 'bypassPermissions';
    tools: string;
  };
  cursor?: {
    sandbox: 'enabled' | 'disabled';
    mode?: 'ask' | 'plan';
    autoReview?: boolean;
    force?: boolean;
  };
  hermes?: { safeMode: boolean; tools: boolean; yolo?: boolean };
  copilot?: { allowAll?: boolean; allowTools?: string[]; availableTools?: string };
  kimi?: { mode: 'isolated' | 'auto' };
}

const permissions: Record<AgentProvider, ProviderPermissionRuntime[]> = {
  codex: [
    {
      id: 'codex-chat',
      label: 'Chat only',
      description: 'No project files, commands, browsing, or external tools.',
      risk: 'safe',
      workspaceAccess: false,
      codex: { sandbox: 'read-only', approval: 'never' },
    },
    {
      id: 'codex-read',
      label: 'Read workspace',
      description: 'Can inspect project files and run read-only analysis inside the workspace.',
      risk: 'safe',
      workspaceAccess: true,
      codex: { sandbox: 'read-only', approval: 'never' },
    },
    {
      id: 'codex-write',
      label: 'Workspace access',
      description: 'Can read, run commands, and edit files inside the configured workspace using the native Windows sandbox.',
      risk: 'caution',
      workspaceAccess: true,
      codex: { sandbox: 'workspace-write', approval: 'never' },
    },
    {
      id: 'codex-full',
      label: 'Full computer access',
      description: 'Runs without a filesystem sandbox. Use only for sessions you fully trust.',
      risk: 'danger',
      workspaceAccess: true,
      codex: { sandbox: 'danger-full-access', approval: 'never' },
    },
  ],
  claude: [
    {
      id: 'claude-chat',
      label: 'Chat only',
      description: 'Tools are disabled; Claude can only answer from the conversation.',
      risk: 'safe',
      workspaceAccess: false,
      claude: { mode: 'dontAsk', tools: '' },
    },
    {
      id: 'claude-plan',
      label: 'Plan & read',
      description: 'Plan mode with read, file search, and text search tools only.',
      risk: 'safe',
      workspaceAccess: true,
      claude: { mode: 'plan', tools: 'Read,Glob,Grep' },
    },
    {
      id: 'claude-edits',
      label: 'Accept edits',
      description: 'Can use tools and apply file edits under Claude’s accept-edits policy.',
      risk: 'caution',
      workspaceAccess: true,
      claude: { mode: 'acceptEdits', tools: 'default' },
    },
    {
      id: 'claude-auto',
      label: 'Auto permissions',
      description: 'Claude automatically decides when its available tools may run.',
      risk: 'caution',
      workspaceAccess: true,
      claude: { mode: 'auto', tools: 'default' },
    },
    {
      id: 'claude-full',
      label: 'Bypass permissions',
      description: 'Bypasses Claude permission checks. Use only for sessions you fully trust.',
      risk: 'danger',
      workspaceAccess: true,
      claude: { mode: 'bypassPermissions', tools: 'default' },
    },
  ],
  cursor: [
    {
      id: 'cursor-chat',
      label: 'Chat only',
      description: 'Sandboxed conversation with an instruction not to use project tools.',
      risk: 'safe',
      workspaceAccess: false,
      cursor: { sandbox: 'enabled', mode: 'ask' },
    },
    {
      id: 'cursor-sandbox',
      label: 'Sandboxed workspace',
      description: 'Can work in the project while Cursor’s sandbox remains enabled.',
      risk: 'safe',
      workspaceAccess: true,
      cursor: { sandbox: 'enabled' },
    },
    {
      id: 'cursor-review',
      label: 'Sandbox + auto review',
      description: 'Sandboxed work with Cursor automatically reviewing requested actions.',
      risk: 'caution',
      workspaceAccess: true,
      cursor: { sandbox: 'enabled', autoReview: true },
    },
    {
      id: 'cursor-trusted',
      label: 'Trusted workspace',
      description: 'Sandbox is disabled, but force/yolo execution remains off.',
      risk: 'caution',
      workspaceAccess: true,
      cursor: { sandbox: 'disabled' },
    },
    {
      id: 'cursor-full',
      label: 'Full / YOLO',
      description: 'Disables the sandbox and automatically approves actions.',
      risk: 'danger',
      workspaceAccess: true,
      cursor: { sandbox: 'disabled', force: true },
    },
  ],
  hermes: [
    {
      id: 'hermes-chat',
      label: 'Chat only',
      description: 'Hermes customizations and toolsets are disabled for a conversation-only session.',
      risk: 'safe',
      workspaceAccess: false,
      hermes: { safeMode: true, tools: false },
    },
    {
      id: 'hermes-workspace',
      label: 'Workspace access',
      description: 'Hermes can use its configured tools inside the project working directory.',
      risk: 'caution',
      workspaceAccess: true,
      hermes: { safeMode: false, tools: true },
    },
    {
      id: 'hermes-full',
      label: 'Full / YOLO',
      description: 'Hermes bypasses dangerous command approvals. Use only in a trusted workspace.',
      risk: 'danger',
      workspaceAccess: true,
      hermes: { safeMode: false, tools: true, yolo: true },
    },
  ],
  copilot: [
    {
      id: 'copilot-chat',
      label: 'Chat only',
      description: 'Copilot runs without file, shell, URL, or MCP tools.',
      risk: 'safe',
      workspaceAccess: false,
      copilot: { availableTools: '' },
    },
    {
      id: 'copilot-workspace',
      label: 'Workspace access',
      description: 'Copilot can read and write files and run shell commands in the project.',
      risk: 'caution',
      workspaceAccess: true,
      copilot: { allowTools: ['read', 'write', 'shell'] },
    },
    {
      id: 'copilot-full',
      label: 'Allow all',
      description: 'Copilot receives all tool, path, and URL permissions.',
      risk: 'danger',
      workspaceAccess: true,
      copilot: { allowAll: true },
    },
  ],
  kimi: [
    {
      id: 'kimi-chat',
      label: 'Chat only',
      description: 'Runs Kimi in an isolated temporary directory without access to project files.',
      risk: 'safe',
      workspaceAccess: false,
      kimi: { mode: 'isolated' },
    },
    {
      id: 'kimi-workspace',
      label: 'Auto workspace',
      description: 'Kimi can inspect, edit, and run tools in the project under its non-interactive auto policy.',
      risk: 'caution',
      workspaceAccess: true,
      kimi: { mode: 'auto' },
    },
  ],
};

export function listProviderPermissions(provider: AgentProvider): ProviderPermissionOption[] {
  return permissions[provider].map(({ id, label, description, risk }) => {
    if (provider !== 'cursor' || process.platform !== 'win32') {
      return { id, label, description, risk };
    }
    const windowsDescriptions: Record<string, { label?: string; description: string }> = {
      'cursor-chat': {
        description: 'Runs in Cursor Ask mode from an isolated temporary directory.',
      },
      'cursor-sandbox': {
        label: 'Protected workspace',
        description: 'Uses Cursor allowlist mode because OS sandboxing is unavailable on Windows.',
      },
      'cursor-review': {
        label: 'Allowlist + auto review',
        description: 'Uses Windows allowlist mode with Cursor automatically reviewing requested actions.',
      },
    };
    return {
      id,
      label: windowsDescriptions[id]?.label ?? label,
      description: windowsDescriptions[id]?.description ?? description,
      risk,
    };
  });
}

export function cursorSandboxForPlatform(
  configured: 'enabled' | 'disabled',
  platform = process.platform,
): 'enabled' | 'disabled' {
  return platform === 'win32' ? 'disabled' : configured;
}

export function getProviderPermission(
  provider: AgentProvider,
  permissionId?: string,
): ProviderPermissionRuntime {
  return permissions[provider].find((item) => item.id === permissionId) ?? permissions[provider][0]!;
}

export function configuredWorkspace(): string {
  if (process.env.RELAY_WORKSPACE_PATH) return resolve(process.env.RELAY_WORKSPACE_PATH);
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
}
