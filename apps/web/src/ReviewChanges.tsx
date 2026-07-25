import { useState } from 'react';
import type { ReviewAction } from './chatClient';

export interface ReviewFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
}

export interface ReviewChangesData {
  title: string;
  summary: string;
  files: ReviewFile[];
}

interface ParsedReviewContent {
  displayContent: string;
  review?: ReviewChangesData;
}

const openTag = '<relay-review>';
const closeTag = '</relay-review>';

export function parseReviewContent(content: string): ParsedReviewContent {
  const start = content.indexOf(openTag);
  if (start < 0) {
    const partialStart = content.indexOf('<relay-review');
    return {
      displayContent: partialStart < 0 ? content : content.slice(0, partialStart).trim(),
    };
  }
  const end = content.indexOf(closeTag, start + openTag.length);
  if (end < 0) return { displayContent: content.slice(0, start).trim() };
  const displayContent = [
    content.slice(0, start),
    content.slice(end + closeTag.length),
  ].join('')
    .replace(/<relay-review>[\s\S]*?<\/relay-review>/g, '')
    .replace(/<relay-review[\s\S]*$/g, '')
    .trim();

  try {
    const raw = JSON.parse(content.slice(start + openTag.length, end)) as Record<string, unknown>;
    const files = Array.isArray(raw.files)
      ? raw.files
          .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
          .map((item): ReviewFile => ({
            path: typeof item.path === 'string' ? item.path.trim() : '',
            status:
              item.status === 'added' || item.status === 'deleted' || item.status === 'renamed'
                ? item.status
                : 'modified',
            additions:
              typeof item.additions === 'number' && item.additions >= 0
                ? Math.round(item.additions)
                : 0,
            deletions:
              typeof item.deletions === 'number' && item.deletions >= 0
                ? Math.round(item.deletions)
                : 0,
          }))
          .filter((file) => file.path)
          .slice(0, 30)
      : [];
    if (!files.length) return { displayContent };
    return {
      displayContent,
      review: {
        title:
          typeof raw.title === 'string' && raw.title.trim()
            ? raw.title.trim()
            : `${files.length} ${files.length === 1 ? 'file' : 'files'} changed`,
        summary: typeof raw.summary === 'string' ? raw.summary.trim() : '',
        files,
      },
    };
  } catch {
    return { displayContent };
  }
}

export function ReviewChanges({
  review,
  action,
  disabled,
  onUndo,
  onRedo,
  onFileSelect,
}: {
  review: ReviewChangesData;
  action?: ReviewAction;
  disabled?: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onFileSelect?: (file: ReviewFile) => void;
}) {
  const [open, setOpen] = useState(false);
  const additions = review.files.reduce((total, file) => total + file.additions, 0);
  const deletions = review.files.reduce((total, file) => total + file.deletions, 0);
  const undoRequested = Boolean(action?.undoRequestedAt && !action.undoCompletedAt && !action.undoError);
  const undoCompleted = Boolean(action?.undoCompletedAt && !action.redoCompletedAt);
  const redoRequested = Boolean(action?.redoRequestedAt && !action.redoCompletedAt && !action.redoError);
  const undoAvailable = Boolean(action?.snapshotId);
  const redoAvailable = Boolean(action?.redoSnapshotId);

  return (
    <div className={`review-card ${open ? 'open' : ''}`}>
      <div className="review-card-head">
        <span className="review-icon">⌘</span>
        <div>
          <strong>{review.title}</strong>
          <span>{review.summary || 'Workspace changes are ready to review.'}</span>
        </div>
        <div className="change-totals">
          <b>+{additions}</b>
          <i>−{deletions}</i>
        </div>
      </div>

      {open && (
        <div className="review-files">
          {review.files.map((file) => (
            <button
              type="button"
              className="review-file"
              key={`${file.status}-${file.path}`}
              onClick={() => onFileSelect?.(file)}
            >
              <span className={`file-status ${file.status}`}>
                {file.status === 'added'
                  ? 'A'
                  : file.status === 'deleted'
                    ? 'D'
                    : file.status === 'renamed'
                      ? 'R'
                      : 'M'}
              </span>
              <code>{file.path}</code>
              <span className="file-diff">
                {file.additions > 0 && <b>+{file.additions}</b>}
                {file.deletions > 0 && <i>−{file.deletions}</i>}
              </span>
              {onFileSelect && <span className="review-file-open">›</span>}
            </button>
          ))}
        </div>
      )}

      <div className="review-actions">
        <button type="button" className="review-toggle" onClick={() => setOpen((value) => !value)}>
          {open ? 'Hide changes' : 'Review changes'}
          <span>{open ? '⌃' : '⌄'}</span>
        </button>
        {undoCompleted ? (
          <button
            type="button"
            className="redo-button"
            disabled={disabled || redoRequested || !redoAvailable}
            onClick={onRedo}
          >
            {redoRequested
              ? 'Redo requested'
              : action?.redoError
                ? '↻ Retry redo'
                : redoAvailable ? '↷ Redo' : 'Redo unavailable'}
          </button>
        ) : (
          <button
            type="button"
            className="undo-button"
            disabled={disabled || undoRequested || !undoAvailable}
            onClick={onUndo}
          >
            {undoRequested
              ? 'Undo requested'
              : action?.undoError
                ? '↻ Retry undo'
                : undoAvailable ? '↶ Undo' : 'Undo unavailable'}
          </button>
        )}
      </div>
    </div>
  );
}
