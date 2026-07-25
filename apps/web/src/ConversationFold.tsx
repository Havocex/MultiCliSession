import { useState } from 'react';
import type { Message } from './chatClient';
import { parseInteractiveContent } from './InteractiveQuestion';
import { parseReviewContent } from './ReviewChanges';
import { parseDiagramContent } from './DiagramCard';
import type { TimelineRestoreMode } from './conversationTimeline';

function preview(message: Message): string {
  if (message.role === 'system') return message.content;
  const withoutDiagram = parseDiagramContent(message.content).displayContent;
  const withoutReview = parseReviewContent(withoutDiagram).displayContent;
  const withoutQuestion = parseInteractiveContent(withoutReview).displayContent;
  return withoutQuestion.replace(/```[\s\S]*?```/g, '[code]').replace(/\s+/g, ' ').trim();
}

export function ConversationFold({
  messages,
  foldedAt,
  hasNewerMessages,
  disabled = false,
  onRestore,
  onDelete,
}: {
  messages: Message[];
  foldedAt: string;
  hasNewerMessages: boolean;
  disabled?: boolean;
  onRestore: (mode: TimelineRestoreMode) => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [restoreChoiceOpen, setRestoreChoiceOpen] = useState(false);
  const turns = messages.filter((message) => message.role === 'user').length;

  return (
    <div className={`conversation-fold ${open ? 'open' : ''}`}>
      <button
        type="button"
        className="fold-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="fold-icon">↶</span>
        <span className="fold-copy">
          <strong>Earlier timeline folded</strong>
          <small>
            {messages.length} messages · {turns} {turns === 1 ? 'turn' : 'turns'} ·{' '}
            {new Date(foldedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </small>
        </span>
        <span className="fold-toggle">{open ? 'Close ↑' : 'Open ↓'}</span>
      </button>

      {open && (
        <div className="folded-messages">
          {messages.map((message) => (
            <div className={`folded-message ${message.role}`} key={message.id}>
              <span>{message.role === 'user' ? 'You' : message.role === 'assistant' ? 'AI' : 'Event'}</span>
              <p>{preview(message) || 'Structured response'}</p>
            </div>
          ))}
        </div>
      )}
      <div className="fold-actions">
        <button
          type="button"
          className="fold-restore"
          disabled={disabled}
          onClick={() => {
            if (hasNewerMessages) {
              setRestoreChoiceOpen(true);
            } else {
              onRestore('replace-current');
            }
          }}
        >
          â†¶ Restore timeline
        </button>
        <button
          type="button"
          className="fold-delete"
          disabled={disabled}
          onClick={() => {
            if (window.confirm(`Permanently delete ${messages.length} folded messages?`)) {
              onDelete();
            }
          }}
        >
          Delete folded timeline
        </button>
      </div>
      {restoreChoiceOpen && (
        <div className="fold-restore-choice" role="dialog" aria-label="Choose timeline restore behavior">
          <strong>A newer timeline exists</strong>
          <p>Choose how the messages written after the rewind should be handled.</p>
          <button type="button" onClick={() => onRestore('replace-current')}>
            <b>Restore earlier timeline</b>
            <span>Keep the newer messages safely inside a folded alternate branch.</span>
          </button>
          <button type="button" onClick={() => onRestore('merge-both')}>
            <b>Merge both timelines</b>
            <span>Make both the restored and newer messages part of the active conversation.</span>
          </button>
          <button type="button" className="fold-choice-cancel" onClick={() => setRestoreChoiceOpen(false)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
