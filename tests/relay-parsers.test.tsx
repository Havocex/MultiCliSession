import assert from 'node:assert/strict';
import test from 'node:test';
import { parseInteractiveContent } from '../apps/web/src/InteractiveQuestion.js';
import { parseReviewContent } from '../apps/web/src/ReviewChanges.js';

const question =
  '<relay-question>{"prompt":"Choose","mode":"single","options":[{"id":"a","label":"A"},{"id":"b","label":"B"}],"allowOther":false,"submitLabel":"Go"}</relay-question>';
const review =
  '<relay-review>{"title":"Changed","summary":"Done","files":[{"path":"a.ts","status":"modified","additions":1,"deletions":0}]}</relay-review>';

test('removes duplicate interactive protocol blocks from visible content', () => {
  const parsed = parseInteractiveContent(`Answer\n${question}\n${question}`);
  assert.equal(parsed.displayContent, 'Answer');
  assert.equal(parsed.question?.prompt, 'Choose');
});

test('removes duplicate review protocol blocks from visible content', () => {
  const parsed = parseReviewContent(`Answer\n${review}\n${review}`);
  assert.equal(parsed.displayContent, 'Answer');
  assert.equal(parsed.review?.files[0]?.path, 'a.ts');
});

test('hides a partial protocol block while it is streaming', () => {
  assert.equal(
    parseInteractiveContent('Answer\n<relay-question>{"prompt":').displayContent,
    'Answer',
  );
});
