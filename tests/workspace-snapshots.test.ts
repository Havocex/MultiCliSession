import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('redo snapshot reapplies modified and newly added workspace files after undo', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'multi-cli-redo-'));
  const workspace = path.join(temporaryRoot, 'workspace');
  const previousDataDirectory = process.env.CHAT_DATA_DIR;
  process.env.CHAT_DATA_DIR = path.join(temporaryRoot, 'data');

  try {
    const {
      createWorkspaceRedoSnapshot,
      createWorkspaceSnapshot,
      restoreWorkspaceFiles,
    } = await import('../apps/server/src/workspace-snapshots.js');

    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, 'existing.txt'), 'before', 'utf8');
    const undoSnapshotId = await createWorkspaceSnapshot(workspace);
    assert.ok(undoSnapshotId);

    await writeFile(path.join(workspace, 'existing.txt'), 'after', 'utf8');
    await writeFile(path.join(workspace, 'added.txt'), 'new file', 'utf8');
    const redoSnapshotId = await createWorkspaceRedoSnapshot(undoSnapshotId);

    const undoResult = await restoreWorkspaceFiles(
      undoSnapshotId,
      ['existing.txt', 'added.txt'],
    );
    assert.equal(await readFile(path.join(workspace, 'existing.txt'), 'utf8'), 'before');
    assert.deepEqual(undoResult.removed, ['added.txt']);

    const redoResult = await restoreWorkspaceFiles(
      redoSnapshotId,
      ['existing.txt', 'added.txt'],
    );
    assert.equal(await readFile(path.join(workspace, 'existing.txt'), 'utf8'), 'after');
    assert.equal(await readFile(path.join(workspace, 'added.txt'), 'utf8'), 'new file');
    assert.deepEqual(redoResult.restored.sort(), ['added.txt', 'existing.txt']);
  } finally {
    if (previousDataDirectory === undefined) delete process.env.CHAT_DATA_DIR;
    else process.env.CHAT_DATA_DIR = previousDataDirectory;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
