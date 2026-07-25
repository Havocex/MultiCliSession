export function normalizeSnapshot(
  text: string,
  previous: string,
): { next: string; delta: string } {
  if (!text || text === previous || previous.startsWith(text)) {
    return { next: previous, delta: '' };
  }
  return {
    next: text,
    delta: text.startsWith(previous) ? text.slice(previous.length) : text,
  };
}
