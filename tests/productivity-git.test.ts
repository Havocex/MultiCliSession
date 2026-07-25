import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { productivityRouter } from '../apps/server/src/productivity-router.js';

test('detects a workspace without Git and initializes it on request', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'multi-cli-git-init-'));
  const app = express();
  app.use(express.json());
  app.use(productivityRouter);
  const server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const before = await fetch(
      `${baseUrl}/git-status?path=${encodeURIComponent(workspace)}`,
    );
    assert.equal(before.ok, true);
    assert.equal((await before.json() as { available?: boolean }).available, false);

    const initialized = await fetch(`${baseUrl}/git-init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: workspace }),
    });
    assert.equal(initialized.ok, true);
    assert.equal((await initialized.json() as { initialized?: boolean }).initialized, true);
    assert.equal((await stat(path.join(workspace, '.git'))).isDirectory(), true);

    const after = await fetch(
      `${baseUrl}/git-status?path=${encodeURIComponent(workspace)}`,
    );
    assert.equal(after.ok, true);
    assert.equal((await after.json() as { available?: boolean }).available, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(workspace, { recursive: true, force: true });
  }
});
