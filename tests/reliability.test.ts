import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCopilotStreamEvent } from '../apps/server/src/cli-agents.js';
import { providerDefinitions } from '../apps/server/src/provider-capabilities.js';
import { listProviderModels } from '../apps/server/src/provider-models.js';
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

test('Copilot emits only assistant message text and never echoes the internal prompt', () => {
  const userEvent = parseCopilotStreamEvent({
    type: 'user.message',
    data: {
      content: 'Internal prompt with <relay-review>fake changes</relay-review>',
    },
  }, '');
  assert.deepEqual(userEvent, { snapshot: '', events: [] });

  const firstDelta = parseCopilotStreamEvent({
    type: 'assistant.message_delta',
    data: { deltaContent: 'שלו' },
  }, userEvent.snapshot);
  const secondDelta = parseCopilotStreamEvent({
    type: 'assistant.message_delta',
    data: { deltaContent: 'ם!' },
  }, firstDelta.snapshot);
  const finalMessage = parseCopilotStreamEvent({
    type: 'assistant.message',
    data: { content: 'שלום!' },
  }, secondDelta.snapshot);

  assert.deepEqual(firstDelta.events, [{ type: 'text_delta', text: 'שלו' }]);
  assert.deepEqual(secondDelta.events, [{ type: 'text_delta', text: 'ם!' }]);
  assert.deepEqual(finalMessage, { snapshot: 'שלום!', events: [] });
});

test('Copilot reasoning is routed to the collapsible thinking card', () => {
  assert.deepEqual(parseCopilotStreamEvent({
    type: 'assistant.reasoning',
    data: { content: 'Short reasoning summary' },
  }, 'answer'), {
    snapshot: 'answer',
    events: [{
      type: 'thinking',
      text: 'Short reasoning summary',
      delta: false,
    }],
  });
});

test('Copilot catalog matches the installed CLI 1.0.75 model picker', async () => {
  const models = await listProviderModels('copilot');
  assert.deepEqual(models.map((model) => model.id), [
    'auto',
    'claude-sonnet-5',
    'claude-sonnet-4.6',
    'claude-sonnet-4.5',
    'claude-haiku-4.5',
    'claude-fable-5',
    'claude-opus-5',
    'claude-opus-4.8',
    'claude-opus-4.8-fast',
    'claude-opus-4.7',
    'claude-opus-4.6',
    'claude-opus-4.5',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.3-codex',
    'gpt-5.4-mini',
    'gpt-5-mini',
    'gemini-3.1-pro-preview',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'kimi-k2.7-code',
  ]);
});
