import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSnapshot } from '../apps/server/src/stream-normalizer.js';

test('emits only the new suffix from cumulative provider snapshots', () => {
  assert.deepEqual(normalizeSnapshot('Hello world', 'Hello'), {
    next: 'Hello world',
    delta: ' world',
  });
});

test('ignores duplicate and stale provider snapshots', () => {
  assert.deepEqual(normalizeSnapshot('Hello', 'Hello'), {
    next: 'Hello',
    delta: '',
  });
  assert.deepEqual(normalizeSnapshot('Hel', 'Hello'), {
    next: 'Hello',
    delta: '',
  });
});

test('emits a replacement snapshot when it is not cumulative', () => {
  assert.deepEqual(normalizeSnapshot('Corrected answer', 'Old answer'), {
    next: 'Corrected answer',
    delta: 'Corrected answer',
  });
});
