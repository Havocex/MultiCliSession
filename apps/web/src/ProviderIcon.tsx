import type { Provider } from './chatClient';

export function ProviderIcon({ provider }: { provider: Provider }) {
  if (provider === 'codex') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <g transform="translate(-1 0)">
          <path d="M12 3.1a4.3 4.3 0 0 1 7.4 3.1 4.3 4.3 0 0 1 1.2 7.9 4.3 4.3 0 0 1-4.9 6.4 4.3 4.3 0 0 1-7.4-3.1 4.3 4.3 0 0 1-1.2-7.9A4.3 4.3 0 0 1 12 3.1Z" />
          <path d="m8.1 9.1 3.9-2.2 3.9 2.2v4.5L12 15.9l-3.9-2.3V9.1Zm0 .1-1-2.6M16 9.2l3-.7M12 15.9v3.3" />
        </g>
      </svg>
    );
  }
  if (provider === 'claude') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 2.8v18.4M4 7.4l16 9.2M4 16.6l16-9.2M7.4 4l9.2 16M16.6 4 7.4 20" />
        <circle cx="12" cy="12" r="2.2" />
      </svg>
    );
  }
  if (provider === 'cursor') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 2.8 21.2 12 12 21.2 2.8 12 12 2.8Z" />
        <path d="M12 7.1 16.9 12 12 16.9 7.1 12 12 7.1Z" />
        <circle cx="12" cy="12" r="1.4" />
      </svg>
    );
  }
  if (provider === 'hermes') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 4v16M9.3 6.3h5.4M8.5 19.7h7" />
        <path d="M11.8 8.2C8 5.2 5 5.7 3 7.2c2.2.2 3.6 1.2 4.5 3.2 1.3-.1 2.8-.8 4.3-2.2ZM12.2 8.2c3.8-3 6.8-2.5 8.8-1-2.2.2-3.6 1.2-4.5 3.2-1.3-.1-2.8-.8-4.3-2.2Z" />
        <path d="M9.1 12.1c1.9-1.1 3.9.3 3.1 1.7-.7 1.1-2.8.9-2.8 2.5 0 1.2 1.3 1.7 2.6 1.7M14.9 12.1c-1.9-1.1-3.9.3-3.1 1.7.7 1.1 2.8.9 2.8 2.5 0 1.2-1.3 1.7-2.6 1.7" />
      </svg>
    );
  }
  if (provider === 'kimi') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path className="kimi-k" d="M6.2 3.8v16.4M7 13.3 16.2 4M10.5 9.8l7.8 10.4" />
        <circle className="kimi-dot" cx="18.3" cy="4.3" r="2" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6.2 7.3A4.8 4.8 0 0 1 10.4 5h3.2a4.8 4.8 0 0 1 4.2 2.3l1.5 2.4v6.1a3.4 3.4 0 0 1-3.4 3.4H8.1a3.4 3.4 0 0 1-3.4-3.4V9.7l1.5-2.4Z" />
      <path d="M8.2 11.2h7.6M9 14.8h.1M14.9 14.8h.1M7.2 6 5.4 3.9M16.8 6l1.8-2.1" />
    </svg>
  );
}
