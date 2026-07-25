import { execFile, type ChildProcess } from 'node:child_process';

/**
 * Stops the complete CLI process tree. On Windows, child.kill() can leave the
 * actual provider process running when the executable is a launcher.
 */
export function stopProcessTree(child: ChildProcess | undefined): void {
  if (!child?.pid || child.killed) return;
  if (process.platform === 'win32') {
    execFile(
      'taskkill.exe',
      ['/pid', String(child.pid), '/t', '/f'],
      { windowsHide: true },
      () => undefined,
    );
    return;
  }
  child.kill('SIGTERM');
  const force = setTimeout(() => {
    if (!child.killed) child.kill('SIGKILL');
  }, 3_000);
  force.unref();
}
