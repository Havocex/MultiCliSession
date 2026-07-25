import assert from 'node:assert/strict';
import test from 'node:test';
import { parseInteractiveContent } from '../apps/web/src/InteractiveQuestion.js';
import { parseReviewContent } from '../apps/web/src/ReviewChanges.js';
import { parseDiagramContent } from '../apps/web/src/DiagramCard.js';

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

test('parses and hides a validated Mermaid diagram protocol block', () => {
  const payload = JSON.stringify({
    version: 1,
    id: 'auth-flow',
    revision: 2,
    renderer: 'mermaid',
    diagramType: 'sequence',
    title: 'Authentication',
    description: 'Authentication request sequence.',
    source: 'sequenceDiagram\nUser->>API: Login',
    references: [{ nodeId: 'API', file: 'src/auth.ts', line: 12 }],
    generatedFrom: ['src/auth.ts'],
  });
  const parsed = parseDiagramContent(`Explanation\n<relay-visual>${payload}</relay-visual>`);
  assert.equal(parsed.displayContent, 'Explanation');
  assert.equal(parsed.diagram?.id, 'auth-flow');
  assert.equal(parsed.diagram?.revision, 2);
  assert.equal(parsed.diagram?.references[0]?.line, 12);
});

test('hides a partial diagram while streaming and rejects executable renderers', () => {
  assert.equal(
    parseDiagramContent('Explanation\n<relay-visual>{"renderer":').displayContent,
    'Explanation',
  );
  const parsed = parseDiagramContent(
    '<relay-visual>{"renderer":"html","source":"<script>alert(1)</script>"}</relay-visual>',
  );
  assert.equal(parsed.diagram, undefined);
  assert.equal(parsed.invalidDiagram, true);
});
