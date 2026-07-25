import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChatPrompt } from '../apps/server/src/chat-prompt.js';

test('prioritizes direct answers and reserves interactive questions for consequential choices', () => {
  const prompt = buildChatPrompt({
    history: [],
    message: 'Explain this code',
    selection: {
      provider: 'codex',
      modelId: 'test-model',
      permissionId: 'codex-chat',
    },
    signal: new AbortController().signal,
  });
  assert.match(prompt, /Default behavior: answer the user directly/);
  assert.match(prompt, /explicit planning\/design phase/);
  assert.match(prompt, /uncommon during implementation, explanation, review/);
});

test('removes UI protocol blocks from conversation history', () => {
  const prompt = buildChatPrompt({
    history: [{
      role: 'assistant',
      content:
        'Visible answer\n<relay-question>{"prompt":"Choose"}</relay-question>' +
        '\n<relay-review>{"files":[]}</relay-review>',
    }],
    message: 'Continue',
    selection: {
      provider: 'codex',
      modelId: 'test-model',
      permissionId: 'codex-chat',
    },
    signal: new AbortController().signal,
  });
  assert.match(prompt, /ASSISTANT: Visible answer/);
  assert.doesNotMatch(prompt.split('Conversation:')[1] ?? '', /<relay-question>/);
  assert.doesNotMatch(prompt.split('Conversation:')[1] ?? '', /<relay-review>/);
});

test('includes project memory and explicitly selected context files', () => {
  const prompt = buildChatPrompt({
    history: [],
    message: 'Continue the implementation',
    projectMemory: 'Always run npm test before handoff.',
    contextFiles: [{ path: 'src/example.ts', content: 'export const ready = true;' }],
    selection: {
      provider: 'codex',
      modelId: 'test-model',
      permissionId: 'codex-read',
    },
    signal: new AbortController().signal,
  });
  assert.match(prompt, /Persistent project instructions:/);
  assert.match(prompt, /Always run npm test before handoff/);
  assert.match(prompt, /--- src\/example\.ts ---/);
  assert.match(prompt, /export const ready = true/);
});

test('identifies additional project workspace roots', () => {
  const prompt = buildChatPrompt({
    history: [],
    message: 'Compare the two packages',
    workingDirectory: 'C:\\workspace\\primary',
    additionalWorkingDirectories: [
      'C:\\workspace\\shared-library',
      'C:\\workspace\\service',
    ],
    selection: {
      provider: 'codex',
      modelId: 'test-model',
      permissionId: 'codex-read',
    },
    signal: new AbortController().signal,
  });
  assert.match(prompt, /Additional project workspace roots/);
  assert.match(prompt, /C:\\workspace\\shared-library/);
  assert.match(prompt, /C:\\workspace\\service/);
});
