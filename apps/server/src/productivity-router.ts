import { execFile } from 'node:child_process';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { Router } from 'express';

const execFileAsync = promisify(execFile);
const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage']);

function safeRoot(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return resolve(value.trim());
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'session';
}

export const productivityRouter = Router();

productivityRouter.get('/files', async (req, res) => {
  const root = safeRoot(req.query.path);
  if (!root) {
    res.status(400).json({ error: 'A workspace path is required.' });
    return;
  }
  try {
    if (!(await stat(root)).isDirectory()) throw new Error('not a directory');
    const files: string[] = [];
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > 6 || files.length >= 1500) return;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (files.length >= 1500) break;
        if (entry.isDirectory()) {
          if (!ignoredDirectories.has(entry.name)) await visit(join(directory, entry.name), depth + 1);
        } else if (entry.isFile()) {
          files.push(relative(root, join(directory, entry.name)).replaceAll('\\', '/'));
        }
      }
    };
    await visit(root, 0);
    res.json({ files: files.sort() });
  } catch {
    res.status(400).json({ error: 'Could not scan this workspace.' });
  }
});

productivityRouter.get('/git-status', async (req, res) => {
  const root = safeRoot(req.query.path);
  if (!root) {
    res.status(400).json({ error: 'A workspace path is required.' });
    return;
  }
  try {
    const [branchResult, statusResult, worktreeResult] = await Promise.all([
      execFileAsync('git', ['-C', root, 'branch', '--show-current'], { windowsHide: true }),
      execFileAsync('git', ['-C', root, 'status', '--porcelain=v1'], { windowsHide: true, maxBuffer: 1024 * 1024 }),
      execFileAsync('git', ['-C', root, 'worktree', 'list', '--porcelain'], { windowsHide: true }),
    ]);
    const changes = statusResult.stdout.split(/\r?\n/).filter(Boolean).map((line) => ({
      status: line.slice(0, 2).trim() || '?',
      path: line.slice(3),
    }));
    const worktrees = worktreeResult.stdout.split(/\r?\n\r?\n/).filter(Boolean).map((block) => {
      const lines = block.split(/\r?\n/);
      return {
        path: lines.find((line) => line.startsWith('worktree '))?.slice(9) ?? '',
        branch: lines.find((line) => line.startsWith('branch '))?.replace('branch refs/heads/', '') ?? '',
      };
    });
    res.json({ branch: branchResult.stdout.trim() || '(detached)', changes, worktrees, available: true });
  } catch {
    res.json({ branch: '', changes: [], worktrees: [], available: false });
  }
});

productivityRouter.post('/git-init', async (req, res) => {
  const root = safeRoot(req.body?.path);
  if (!root) {
    res.status(400).json({ error: 'A workspace path is required.' });
    return;
  }
  try {
    if (!(await stat(root)).isDirectory()) {
      res.status(400).json({ error: 'The workspace path is not a directory.' });
      return;
    }
    try {
      const repositoryRoot = (await execFileAsync(
        'git',
        ['-C', root, 'rev-parse', '--show-toplevel'],
        { windowsHide: true },
      )).stdout.trim();
      res.json({ ok: true, initialized: false, repositoryRoot });
      return;
    } catch {
      // The selected folder is not in a repository yet.
    }
    await execFileAsync('git', ['-C', root, 'init'], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const repositoryRoot = (await execFileAsync(
      'git',
      ['-C', root, 'rev-parse', '--show-toplevel'],
      { windowsHide: true },
    )).stdout.trim();
    res.json({ ok: true, initialized: true, repositoryRoot });
  } catch (error) {
    res.status(400).json({
      error: (error as { stderr?: string }).stderr?.trim() ||
        (error instanceof Error ? error.message : 'Could not initialize Git.'),
    });
  }
});

productivityRouter.post('/worktree', async (req, res) => {
  const root = safeRoot(req.body?.path);
  const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
  const title = typeof req.body?.title === 'string' ? req.body.title : 'session';
  if (!root || !sessionId) {
    res.status(400).json({ error: 'Workspace and session are required.' });
    return;
  }
  try {
    const repo = (await execFileAsync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
      windowsHide: true,
    })).stdout.trim();
    const shortId = sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
    const branch = `multi-cli/${slug(title)}-${shortId}`;
    const worktreesRoot = join(dirname(repo), '.multi-cli-worktrees');
    const destination = join(worktreesRoot, `${basename(repo)}-${shortId}`);
    await mkdir(worktreesRoot, { recursive: true });
    const relativeDestination = resolve(destination);
    if (relativeDestination !== resolve(worktreesRoot) &&
      !relativeDestination.startsWith(`${resolve(worktreesRoot)}${sep}`)) {
      throw new Error('Invalid worktree destination.');
    }
    await execFileAsync('git', ['-C', repo, 'worktree', 'add', '-b', branch, destination, 'HEAD'], {
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    res.json({ path: destination, branch });
  } catch (error) {
    const detail = (error as { stderr?: string }).stderr?.trim();
    res.status(400).json({ error: detail || (error instanceof Error ? error.message : 'Could not create worktree.') });
  }
});

productivityRouter.post('/worktree-action', async (req, res) => {
  const root = safeRoot(req.body?.path);
  const worktree = safeRoot(req.body?.worktreePath);
  const branch = typeof req.body?.branch === 'string' ? req.body.branch.trim() : '';
  const action = req.body?.action;
  if (!root || !worktree || !branch || !['merge', 'remove'].includes(action)) {
    res.status(400).json({ error: 'Project, worktree, branch, and a valid action are required.' });
    return;
  }
  try {
    const repo = (await execFileAsync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
      windowsHide: true,
    })).stdout.trim();
    const registered = (await execFileAsync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], {
      windowsHide: true,
    })).stdout.split(/\r?\n/).some((line) =>
      line.startsWith('worktree ') && resolve(line.slice(9)) === worktree,
    );
    if (!registered || !branch.startsWith('multi-cli/')) {
      throw new Error('This is not a managed session worktree.');
    }
    const dirty = (await execFileAsync('git', ['-C', worktree, 'status', '--porcelain'], {
      windowsHide: true,
    })).stdout.trim();
    if (dirty) throw new Error('Commit or discard the worktree changes before continuing.');
    if (action === 'merge') {
      await execFileAsync('git', ['-C', repo, 'merge', '--no-ff', branch], {
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
      });
      res.json({ ok: true, merged: true });
      return;
    }
    await execFileAsync('git', ['-C', repo, 'worktree', 'remove', worktree], {
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    await execFileAsync('git', ['-C', repo, 'branch', '-d', branch], {
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    }).catch(() => undefined);
    await execFileAsync('git', ['-C', repo, 'worktree', 'prune'], { windowsHide: true });
    res.json({ ok: true, removed: true });
  } catch (error) {
    res.status(400).json({
      error: (error as { stderr?: string }).stderr?.trim() ||
        (error instanceof Error ? error.message : 'Worktree action failed.'),
    });
  }
});

productivityRouter.post('/git-action', async (req, res) => {
  const root = safeRoot(req.body?.path);
  const file = typeof req.body?.file === 'string' ? req.body.file.trim() : '';
  const action = req.body?.action;
  if (!root || !file || !['stage', 'unstage', 'discard'].includes(action)) {
    res.status(400).json({ error: 'Workspace, file, and a valid Git action are required.' });
    return;
  }
  const absolute = resolve(root, file);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    res.status(400).json({ error: 'The requested file is outside the workspace.' });
    return;
  }
  try {
    if (action === 'stage') {
      await execFileAsync('git', ['-C', root, 'add', '--', file], { windowsHide: true });
    } else if (action === 'unstage') {
      await execFileAsync('git', ['-C', root, 'restore', '--staged', '--', file], { windowsHide: true });
    } else {
      const status = (await execFileAsync('git', ['-C', root, 'status', '--porcelain=v1', '--', file], {
        windowsHide: true,
      })).stdout.slice(0, 2);
      if (status === '??') {
        await execFileAsync('git', ['-C', root, 'clean', '-f', '--', file], { windowsHide: true });
      } else {
        await execFileAsync('git', ['-C', root, 'restore', '--worktree', '--', file], { windowsHide: true });
      }
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({
      error: (error as { stderr?: string }).stderr?.trim() ||
        (error instanceof Error ? error.message : 'Git action failed.'),
    });
  }
});
