import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../apps/web/src/chatClient.js';
import {
  deleteFoldedTimeline,
  restoreFoldedTimeline,
} from '../apps/web/src/conversationTimeline.js';

const message = (id: string, role: 'user' | 'assistant', content = id): Message => ({
  id,
  role,
  content,
});

function fold(messages: Message[]): Message {
  return {
    id: 'fold',
    role: 'system',
    content: 'folded',
    sessionEvent: {
      type: 'folded-conversation',
      foldedAt: '2026-01-01T00:00:00.000Z',
      messages,
    },
  };
}

test('restores a folded timeline directly when no newer messages exist', () => {
  const result = restoreFoldedTimeline(
    [message('before', 'user'), fold([message('old-a', 'assistant'), message('old-b', 'user')])],
    'fold',
    'replace-current',
  );
  assert.deepEqual(result.map((item) => item.id), ['before', 'old-a', 'old-b']);
});

test('restores the old timeline and preserves newer work as an alternate fold', () => {
  const result = restoreFoldedTimeline(
    [
      message('before', 'user'),
      fold([message('old-a', 'assistant')]),
      message('new-a', 'user'),
      message('new-b', 'assistant'),
    ],
    'fold',
    'replace-current',
    () => 'alternate-fold',
  );
  assert.deepEqual(result.map((item) => item.id), ['before', 'old-a', 'alternate-fold']);
  const alternate = result.at(-1);
  assert.equal(alternate?.sessionEvent?.type, 'folded-conversation');
  if (alternate?.sessionEvent?.type === 'folded-conversation') {
    assert.deepEqual(alternate.sessionEvent.messages.map((item) => item.id), ['new-a', 'new-b']);
  }
});

test('can merge restored and newer timelines into the active conversation', () => {
  const result = restoreFoldedTimeline(
    [
      message('before', 'user'),
      fold([message('old-a', 'assistant')]),
      message('new-a', 'user'),
    ],
    'fold',
    'merge-both',
  );
  assert.deepEqual(result.map((item) => item.id), ['before', 'old-a', 'new-a']);
});

test('deletes only the selected folded timeline', () => {
  const result = deleteFoldedTimeline(
    [message('before', 'user'), fold([message('old-a', 'assistant')]), message('after', 'user')],
    'fold',
  );
  assert.deepEqual(result.map((item) => item.id), ['before', 'after']);
});
