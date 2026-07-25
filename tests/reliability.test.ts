import assert from 'node:assert/strict';
import test from 'node:test';
import { providerDefinitions } from '../apps/server/src/provider-capabilities.js';
import {
  cursorSandboxForPlatform,
  getProviderPermission,
} from '../apps/server/src/provider-permissions.js';
import {
  mergeChatLibraries,
  type ChatLibrary,
} from '../apps/web/src/workspaceStore.js';

test('merges concurrent library edits without dropping remote sessions or local messages', () => {
  const remote: ChatLibrary = {
    version: 1,
    revision: 8,
    activeProjectId: 'project',
    projects: [{
      id: 'project',
      name: 'Remote name',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-02',
      activeSessionId: 'remote-session',
      sessions: [{
        id: 'remote-session',
        title: 'Remote session',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        messages: [],
      }],
    }],
  };
  const local: ChatLibrary = {
    ...remote,
    revision: 7,
    projects: [{
      ...remote.projects[0]!,
      name: 'Local name',
      activeSessionId: 'local-session',
      sessions: [{
        id: 'local-session',
        title: 'Local session',
        createdAt: '2026-01-02',
        updatedAt: '2026-01-02',
        pendingPrompts: ['Continue after refresh'],
        messages: [{ id: 'message', role: 'user', content: 'Keep me' }],
      }],
    }],
  };

  const merged = mergeChatLibraries(remote, local);
  assert.equal(merged.revision, 8);
  assert.equal(merged.projects[0]?.name, 'Local name');
  assert.deepEqual(
    merged.projects[0]?.sessions.map((session) => session.id).sort(),
    ['local-session', 'remote-session'],
  );
  assert.deepEqual(
    merged.projects[0]?.sessions.find((session) => session.id === 'local-session')?.pendingPrompts,
    ['Continue after refresh'],
  );
});

test('provider capability registry is complete and does not advertise Kimi effort control', () => {
  assert.deepEqual(
    providerDefinitions.map((provider) => provider.id).sort(),
    ['claude', 'codex', 'copilot', 'cursor', 'hermes', 'kimi'],
  );
  assert.equal(
    providerDefinitions.find((provider) => provider.id === 'kimi')
      ?.capabilities.supportsReasoningEffort,
    false,
  );
  assert.ok(providerDefinitions.every((provider) => provider.capabilities.setupCommand));
});

test('Cursor falls back to allowlist mode on Windows', () => {
  assert.equal(cursorSandboxForPlatform('enabled', 'win32'), 'disabled');
  assert.equal(cursorSandboxForPlatform('enabled', 'linux'), 'enabled');
  assert.equal(cursorSandboxForPlatform('disabled', 'darwin'), 'disabled');
});

test('Cursor trusted workspace auto-reviews safe actions without enabling YOLO', () => {
  const permission = getProviderPermission('cursor', 'cursor-trusted');
  assert.equal(permission.cursor?.sandbox, 'disabled');
  assert.equal(permission.cursor?.autoReview, true);
  assert.notEqual(permission.cursor?.force, true);
});
