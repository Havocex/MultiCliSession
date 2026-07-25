import { useEffect, useState } from 'react';
import type { MessageReasoning } from './chatClient';

function elapsed(reasoning: MessageReasoning): string | undefined {
  if (!reasoning.completedAt) return undefined;
  const milliseconds =
    new Date(reasoning.completedAt).getTime() - new Date(reasoning.startedAt).getTime();
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return undefined;
  if (milliseconds < 1000) return '<1s';
  return `${Math.max(1, Math.round(milliseconds / 1000))}s`;
}

export function ReasoningCard({ reasoning }: { reasoning: MessageReasoning }) {
  const live = reasoning.status === 'thinking';
  const [open, setOpen] = useState(live);

  useEffect(() => {
    setOpen(live);
  }, [live]);

  return (
    <div className={`reasoning-card ${live ? 'live' : 'complete'} ${open ? 'open' : ''}`}>
      <button
        type="button"
        className="reasoning-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="reasoning-orb">
          <i />
          <i />
          <i />
        </span>
        <span className="reasoning-title">
          <strong>{live ? 'Thinking…' : 'Reasoning'}</strong>
          <small>
            {live
              ? 'Live reasoning stream'
              : `Completed${elapsed(reasoning) ? ` in ${elapsed(reasoning)}` : ''}`}
          </small>
        </span>
        <span className="reasoning-toggle">{open ? 'Hide ↑' : 'Show ↓'}</span>
      </button>
      {open && (
        <div className="reasoning-content">
          <pre>{reasoning.content}</pre>
          {live && <span className="reasoning-caret" aria-hidden="true" />}
        </div>
      )}
    </div>
  );
}
