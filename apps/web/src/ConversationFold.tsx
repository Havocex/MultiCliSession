import { useState } from 'react';
import type { Message } from './chatClient';
import { parseInteractiveContent } from './InteractiveQuestion';
import { parseReviewContent } from './ReviewChanges';

function preview(message: Message): string {
  if (message.role === 'system') return message.content;
  const withoutReview = parseReviewContent(message.content).displayContent;
  const withoutQuestion = parseInteractiveContent(withoutReview).displayContent;
  return withoutQuestion.replace(/```[\s\S]*?```/g, '[code]').replace(/\s+/g, ' ').trim();
}

export function ConversationFold({
  messages,
  foldedAt,
}: {
  messages: Message[];
  foldedAt: string;
}) {
  const [open, setOpen] = useState(false);
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
    </div>
  );
}
