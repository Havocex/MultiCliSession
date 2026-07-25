import { randomUUID } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

interface SnapshotManifest {
  id: string;
  workspace: string;
  createdAt: string;
  complete: boolean;
  files: Record<string, 'captured' | 'too-large'>;
}

const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build', '.next']);
const sensitiveFilePattern =
  /(?:^|\/)(?:\.env(?:\..*)?|credentials?(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i;
const maximumFiles = 5_000;
const maximumFileBytes = 2 * 1024 * 1024;
const maximumSnapshotBytes = 25 * 1024 * 1024;
const snapshotsRoot = path.resolve(
  process.env.CHAT_DATA_DIR?.trim() || path.resolve(process.cwd(), 'data'),
  'workspace-snapshots',
);
const snapshotRetentionMs = Math.max(
  60 * 60 * 1000,
  Number(process.env.CHAT_SNAPSHOT_RETENTION_HOURS || 72) * 60 * 60 * 1000,
);
const maximumSnapshots = Math.max(
  5,
  Number(process.env.CHAT_MAX_SNAPSHOTS || 40),
);

export async function pruneWorkspaceSnapshots(now = Date.now()): Promise<number> {
  let entries;
  try {
    entries = await readdir(snapshotsRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  const snapshots = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && /^[a-f0-9-]{36}$/i.test(entry.name))
    .map(async (entry) => {
      try {
        const manifest = await readManifest(entry.name);
        return { id: entry.name, createdAt: Date.parse(manifest.createdAt) || 0 };
      } catch {
        return { id: entry.name, createdAt: 0 };
      }
    }));
  snapshots.sort((left, right) => right.createdAt - left.createdAt);
  const expired = snapshots.filter(
    (snapshot, index) =>
      index >= maximumSnapshots || now - snapshot.createdAt > snapshotRetentionMs,
  );
  await Promise.all(expired.map((snapshot) =>
    rm(path.join(snapshotsRoot, snapshot.id), { recursive: true, force: true }),
  ));
  return expired.length;
}

function safeRelativePath(value: string): string | undefined {
  const normalized = value.replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').includes('..')) return undefined;
  return normalized;
}

async function readManifest(snapshotId: string): Promise<SnapshotManifest> {
  if (!/^[a-f0-9-]{36}$/i.test(snapshotId)) throw new Error('Invalid snapshot identifier.');
  return JSON.parse(
    await readFile(path.join(snapshotsRoot, snapshotId, 'manifest.json'), 'utf8'),
  ) as SnapshotManifest;
}

export async function createWorkspaceSnapshot(workspace: string): Promise<string | undefined> {
  await pruneWorkspaceSnapshots().catch(() => 0);
  const root = path.resolve(workspace);
  try {
    if (!(await lstat(root)).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  const id = randomUUID();
  const snapshotDirectory = path.join(snapshotsRoot, id);
  const filesDirectory = path.join(snapshotDirectory, 'files');
  const manifest: SnapshotManifest = {
    id,
    workspace: root,
    createdAt: new Date().toISOString(),
    complete: true,
    files: {},
  };
  let capturedBytes = 0;
  let visitedFiles = 0;

  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      manifest.complete = false;
      return;
    }
    for (const entry of entries) {
      if (visitedFiles >= maximumFiles) {
        manifest.complete = false;
        return;
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) await visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      visitedFiles += 1;
      const relative = path.relative(root, absolute).replaceAll('\\', '/');
      if (sensitiveFilePattern.test(relative)) {
        manifest.files[relative] = 'too-large';
        manifest.complete = false;
        continue;
      }
      try {
        const details = await lstat(absolute);
        if (
          details.size > maximumFileBytes ||
          capturedBytes + details.size > maximumSnapshotBytes
        ) {
          manifest.files[relative] = 'too-large';
          manifest.complete = false;
          continue;
        }
        const target = path.join(filesDirectory, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(absolute, target);
        capturedBytes += details.size;
        manifest.files[relative] = 'captured';
      } catch {
        manifest.complete = false;
      }
    }
  };

  await mkdir(filesDirectory, { recursive: true });
  await visit(root);
  await writeFile(
    path.join(snapshotDirectory, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );
  return id;
}

export async function createWorkspaceRedoSnapshot(snapshotId: string): Promise<string> {
  const manifest = await readManifest(snapshotId);
  const redoSnapshotId = await createWorkspaceSnapshot(manifest.workspace);
  if (!redoSnapshotId) {
    throw new Error('Could not capture the current workspace before undo.');
  }
  return redoSnapshotId;
}

export async function restoreWorkspaceFiles(
  snapshotId: string,
  requestedFiles: string[],
): Promise<{ restored: string[]; removed: string[]; skipped: string[] }> {
  const manifest = await readManifest(snapshotId);
  const snapshotDirectory = path.join(snapshotsRoot, snapshotId, 'files');
  const restored: string[] = [];
  const removed: string[] = [];
  const skipped: string[] = [];

  for (const requested of requestedFiles.slice(0, 100)) {
    const relative = safeRelativePath(requested);
    if (!relative) {
      skipped.push(requested);
      continue;
    }
    const target = path.resolve(manifest.workspace, relative);
    if (
      target !== manifest.workspace &&
      !target.startsWith(`${manifest.workspace}${path.sep}`)
    ) {
      skipped.push(requested);
      continue;
    }
    const status = manifest.files[relative];
    if (status === 'captured') {
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(snapshotDirectory, relative), target);
      restored.push(relative);
    } else if (status === 'too-large' || (!status && !manifest.complete)) {
      skipped.push(relative);
    } else {
      await rm(target, { force: true });
      removed.push(relative);
    }
  }
  return { restored, removed, skipped };
}
