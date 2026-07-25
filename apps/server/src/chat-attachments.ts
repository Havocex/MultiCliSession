import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { AgentAttachment } from './types.js';

interface IncomingAttachment {
  name?: unknown;
  mimeType?: unknown;
  size?: unknown;
  kind?: unknown;
  dataUrl?: unknown;
  textContent?: unknown;
}

const maximumAttachments = 6;
const maximumFileBytes = 3 * 1024 * 1024;
const maximumTotalBytes = 5 * 1024 * 1024;
const safeExtension = /^\.[a-zA-Z0-9]{1,10}$/;

function safeName(value: string, index: number): string {
  const cleaned = value
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  const extension = extname(cleaned);
  return cleaned || `attachment-${index + 1}${safeExtension.test(extension) ? extension : ''}`;
}

function decodeDataUrl(value: string): Buffer | undefined {
  const match = value.match(/^data:([^;,]{1,100});base64,([a-zA-Z0-9+/=\r\n]+)$/);
  if (!match) return undefined;
  try {
    return Buffer.from(match[2]!, 'base64');
  } catch {
    return undefined;
  }
}

export async function materializeChatAttachments(
  values: unknown[],
): Promise<{
  attachments: AgentAttachment[];
  directory?: string;
  cleanup: () => Promise<void>;
}> {
  const directory = values.length ? await mkdtemp(join(tmpdir(), 'multi-cli-attachments-')) : undefined;
  const attachments: AgentAttachment[] = [];
  let totalBytes = 0;

  try {
    for (const [index, raw] of values.slice(0, maximumAttachments).entries()) {
      if (!raw || typeof raw !== 'object') continue;
      const value = raw as IncomingAttachment;
      const name = safeName(typeof value.name === 'string' ? value.name : '', index);
      const mimeType =
        typeof value.mimeType === 'string' && value.mimeType.length <= 120
          ? value.mimeType
          : 'application/octet-stream';
      const kind = value.kind === 'image' ? 'image' : 'document';
      const textContent =
        typeof value.textContent === 'string'
          ? value.textContent.slice(0, maximumFileBytes)
          : undefined;
      const binary =
        typeof value.dataUrl === 'string' ? decodeDataUrl(value.dataUrl) : undefined;
      const bytes = binary?.byteLength ?? Buffer.byteLength(textContent ?? '', 'utf8');
      if (!bytes || bytes > maximumFileBytes || totalBytes + bytes > maximumTotalBytes) continue;
      totalBytes += bytes;

      let path: string | undefined;
      if (directory) {
        path = join(directory, `${index + 1}-${name}`);
        await writeFile(path, binary ?? textContent!, binary ? undefined : 'utf8');
      }
      attachments.push({
        name,
        mimeType,
        size: bytes,
        kind,
        path,
        textContent,
      });
    }
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true });
    throw error;
  }

  return {
    attachments,
    directory,
    cleanup: async () => {
      if (directory) await rm(directory, { recursive: true, force: true });
    },
  };
}
