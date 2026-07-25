import { useState, type ReactNode } from 'react';

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    return part;
  });
}

function prose(content: string, key: string): ReactNode {
  return (
    <span key={key}>
      {content.split('\n').map((line, lineIndex) => (
        <span key={lineIndex}>{inline(line)}<br /></span>
      ))}
    </span>
  );
}

function parseFenceInfo(value: string): { language: string; fileName?: string } {
  const info = value.trim();
  if (!info) return { language: 'text' };
  const language = info.split(/\s+/)[0] || 'text';
  const quotedFile = info.match(/(?:file|filename|title)=["']([^"']+)["']/i)?.[1];
  const plainFile = info.match(/(?:file|filename|title)=([^\s]+)/i)?.[1];
  const trailingFile = info.slice(language.length).trim();
  return {
    language,
    fileName: quotedFile ?? plainFile ?? (trailingFile || undefined),
  };
}

function CodeCard({
  code,
  language,
  fileName,
}: {
  code: string;
  language: string;
  fileName?: string;
}) {
  const [copied, setCopied] = useState(false);
  const normalizedCode = code.replace(/\n$/, '');
  const lines = normalizedCode.split('\n');
  const copy = async () => {
    await navigator.clipboard.writeText(normalizedCode);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="ide-code-card">
      <div className="ide-code-header">
        <span className="window-dots"><i /><i /><i /></span>
        <span className="code-file-name">{fileName ?? `${language || 'text'} snippet`}</span>
        <span className="code-language">{language || 'text'}</span>
        <button type="button" onClick={() => void copy()}>
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      <pre aria-label={`${language} code`}>
        <code>
          {lines.map((line, index) => (
            <span className="code-line" key={index}>
              <span className="line-number" aria-hidden="true">{index + 1}</span>
              <span className="line-content">{line || ' '}</span>
            </span>
          ))}
        </code>
      </pre>
      <div className="ide-code-footer">
        <span>UTF-8</span>
        <span>{lines.length} {lines.length === 1 ? 'line' : 'lines'}</span>
      </div>
    </div>
  );
}

export function renderMarkdownLite(content: string): ReactNode {
  const result: ReactNode[] = [];
  const fence = /```([^\n`]*)\n([\s\S]*?)```/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(content))) {
    if (match.index > cursor) {
      result.push(prose(content.slice(cursor, match.index), `text-${cursor}`));
    }
    const info = parseFenceInfo(match[1] ?? '');
    result.push(
      <CodeCard
        key={`code-${match.index}`}
        code={match[2] ?? ''}
        language={info.language}
        fileName={info.fileName}
      />,
    );
    cursor = fence.lastIndex;
  }
  if (cursor < content.length) result.push(prose(content.slice(cursor), `text-${cursor}`));
  return result.length ? result : prose(content, 'text-only');
}
