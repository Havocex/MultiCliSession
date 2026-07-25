import type { Message } from './chatClient';

export type TimelineRestoreMode = 'replace-current' | 'merge-both';

export function restoreFoldedTimeline(
  messages: Message[],
  foldId: string,
  mode: TimelineRestoreMode,
  idFactory: () => string = () => crypto.randomUUID(),
): Message[] {
  const index = messages.findIndex((message) => message.id === foldId);
  const fold = messages[index];
  if (
    index < 0 ||
    fold?.role !== 'system' ||
    fold.sessionEvent?.type !== 'folded-conversation'
  ) {
    return messages;
  }
  const before = messages.slice(0, index);
  const newerTimeline = messages.slice(index + 1);
  const restoredTimeline = fold.sessionEvent.messages;
  if (mode === 'merge-both' || !newerTimeline.length) {
    return [...before, ...restoredTimeline, ...newerTimeline];
  }
  const alternateFold: Message = {
    id: idFactory(),
    role: 'system',
    content: `${newerTimeline.length} messages from the newer timeline were preserved as an alternate branch.`,
    sessionEvent: {
      type: 'folded-conversation',
      foldedAt: new Date().toISOString(),
      messages: newerTimeline,
    },
  };
  return [...before, ...restoredTimeline, alternateFold];
}

export function deleteFoldedTimeline(messages: Message[], foldId: string): Message[] {
  const fold = messages.find((message) => message.id === foldId);
  if (fold?.role !== 'system' || fold.sessionEvent?.type !== 'folded-conversation') {
    return messages;
  }
  return messages.filter((message) => message.id !== foldId);
}
