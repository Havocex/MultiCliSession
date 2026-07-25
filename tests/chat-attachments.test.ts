import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import { materializeChatAttachments } from '../apps/server/src/chat-attachments.js';

test('materializes attachments in temporary storage and removes them on cleanup', async () => {
  const bundle = await materializeChatAttachments([{
    name: '../unsafe:image.png',
    mimeType: 'image/png',
    kind: 'image',
    dataUrl: `data:image/png;base64,${Buffer.from('image bytes').toString('base64')}`,
  }]);

  assert.equal(bundle.attachments.length, 1);
  const attachment = bundle.attachments[0]!;
  assert.equal(attachment.name.includes('..'), false);
  assert.equal(attachment.name.includes(':'), false);
  assert.ok(attachment.path);
  assert.equal(await readFile(attachment.path, 'utf8'), 'image bytes');

  await bundle.cleanup();
  await assert.rejects(() => stat(attachment.path!));
});
