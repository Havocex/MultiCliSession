import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from './apiClient';
import type { Message } from './chatClient';
import { renderMarkdownLite } from './markdownLite';
import { parseReviewContent, ReviewChanges, type ReviewFile } from './ReviewChanges';
import {
  DiagramCard,
  parseDiagramContent,
  type DiagramData,
  type DiagramReference,
} from './DiagramCard';

interface Artifact {
  id: string;
  title: string;
  kind: 'Markdown' | 'Plan' | 'Diagram';
  content: string;
  diagram?: DiagramData;
  diagramHistory?: DiagramData[];
}

interface WorkspaceArtifact {
  path: string;
  title: string;
  kind: 'Markdown' | 'Plan';
  content: string;
  updatedAt: string;
}

function artifactTitle(info: string, fallback: string): string {
  const quoted = info.match(/(?:file|filename|title)=["']([^"']+)["']/i)?.[1];
  const plain = info.match(/(?:file|filename|title)=([^\s]+)/i)?.[1];
  return quoted ?? plain ?? fallback;
}

function collectArtifacts(messages: Message[]): Artifact[] {
  const artifacts: Artifact[] = [];
  const diagrams = new Map<string, DiagramData[]>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.content) continue;
    const diagramParsed = parseDiagramContent(message.content);
    if (diagramParsed.diagram) {
      const history = diagrams.get(diagramParsed.diagram.id) ?? [];
      history.push(diagramParsed.diagram);
      diagrams.set(diagramParsed.diagram.id, history);
    }
    const display = parseReviewContent(diagramParsed.displayContent).displayContent;
    const fence = /```([^\n`]*)\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;
    let foundMarkdown = false;
    while ((match = fence.exec(display))) {
      const info = match[1]!.trim();
      const title = artifactTitle(info, 'Markdown document');
      const language = info.split(/\s+/)[0]?.toLowerCase();
      if (language === 'md' || language === 'markdown' || title.toLowerCase().endsWith('.md')) {
        artifacts.push({
          id: `${message.id}-${match.index}`,
          title,
          kind: 'Markdown',
          content: match[2]!.replace(/\n$/, ''),
        });
        foundMarkdown = true;
      }
    }
    const planHeading = display.match(/(?:^|\n)#{1,3}\s*(?:plan|implementation plan|תוכנית|תכנית)(?:\s*[:—-]\s*([^\n]+))?/i);
    if (planHeading && !foundMarkdown) {
      artifacts.push({
        id: `${message.id}-plan`,
        title: planHeading[1]?.trim() || 'Implementation plan',
        kind: 'Plan',
        content: display,
      });
    }
  }
  for (const [diagramId, history] of diagrams) {
    history.sort((left, right) => left.revision - right.revision);
    const diagram = history.at(-1)!;
    artifacts.push({
      id: `diagram-${diagramId}`,
      title: diagram.title,
      kind: 'Diagram',
      content: diagram.source,
      diagram,
      diagramHistory: history,
    });
  }
  return artifacts.slice(-20).reverse();
}

export function WorkspaceInspector({
  messages,
  open,
  collapsed,
  sending,
  workingDirectory,
  workingDirectories,
  requestedReference,
  onClose,
  onToggleCollapsed,
  onResize,
  onUndo,
}: {
  messages: Message[];
  open: boolean;
  collapsed: boolean;
  sending: boolean;
  workingDirectory?: string;
  workingDirectories: string[];
  requestedReference?: DiagramReference;
  onClose: () => void;
  onToggleCollapsed: () => void;
  onResize: (width: number) => void;
  onUndo: (messageId: string, review: NonNullable<ReturnType<typeof parseReviewContent>['review']>) => void;
}) {
  const [tab, setTab] = useState<'artifacts' | 'changes'>('artifacts');
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedDiff, setSelectedDiff] = useState<ReviewFile>();
  const [diffLines, setDiffLines] = useState<Array<{ type: 'add' | 'remove' | 'context'; content: string }>>([]);
  const [workspaceArtifacts, setWorkspaceArtifacts] = useState<WorkspaceArtifact[]>([]);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [referencePreview, setReferencePreview] = useState<{
    path: string;
    root: string;
    content: string;
    error?: string;
  }>();
  useEffect(() => {
    if (!requestedReference) return;
    setReferenceOpen(true);
    setSelectedId(undefined);
    setSelectedDiff(undefined);
    setReferencePreview({ path: requestedReference.file, root: '', content: '' });
    const controller = new AbortController();
    void apiFetch('/api/chat/workspace-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roots: workingDirectories, file: requestedReference.file }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json() as {
          path?: string;
          root?: string;
          content?: string;
          error?: string;
        };
        if (!response.ok || typeof body.content !== 'string') {
          throw new Error(body.error || 'Could not open the referenced file.');
        }
        setReferencePreview({
          path: body.path || requestedReference.file,
          root: body.root || '',
          content: body.content,
        });
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setReferencePreview({
            path: requestedReference.file,
            root: '',
            content: '',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => controller.abort();
  }, [requestedReference, workingDirectories.join('|')]);
  useEffect(() => {
    const path = workingDirectory?.trim();
    if (!path) {
      setWorkspaceArtifacts([]);
      return;
    }
    const controller = new AbortController();
    void apiFetch(`/api/chat/workspace-artifacts?path=${encodeURIComponent(path)}`, {
      signal: controller.signal,
    })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data: { artifacts?: WorkspaceArtifact[] }) =>
        setWorkspaceArtifacts(Array.isArray(data.artifacts) ? data.artifacts : []),
      )
      .catch(() => {
        if (!controller.signal.aborted) setWorkspaceArtifacts([]);
      });
    return () => controller.abort();
  }, [workingDirectory, messages.length, sending]);
  const artifacts = useMemo(() => {
    const disk: Artifact[] = workspaceArtifacts.map((artifact) => ({
      id: `file-${artifact.path}`,
      title: artifact.path,
      kind: artifact.kind,
      content: artifact.content,
    }));
    const diskTitles = new Set(workspaceArtifacts.map((artifact) => artifact.title.toLowerCase()));
    return [
      ...disk,
      ...collectArtifacts(messages).filter((artifact) => !diskTitles.has(artifact.title.toLowerCase())),
    ];
  }, [messages, workspaceArtifacts]);
  const reviews = useMemo(
    () => messages.flatMap((message) => {
      if (message.role !== 'assistant') return [];
      const review = parseReviewContent(message.content).review;
      return review ? [{ message, review }] : [];
    }).reverse(),
    [messages],
  );
  const selected = artifacts.find((artifact) => artifact.id === selectedId);
  useEffect(() => {
    if (!selectedDiff || !workingDirectory) {
      setDiffLines([]);
      return;
    }
    const controller = new AbortController();
    const query = new URLSearchParams({
      path: workingDirectory,
      file: selectedDiff.path,
      status: selectedDiff.status,
    });
    void apiFetch(`/api/chat/workspace-diff?${query}`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data: { lines?: Array<{ type: 'add' | 'remove' | 'context'; content: string }> }) =>
        setDiffLines(Array.isArray(data.lines) ? data.lines : []),
      )
      .catch(() => {
        if (!controller.signal.aborted) setDiffLines([]);
      });
    return () => controller.abort();
  }, [selectedDiff, workingDirectory]);

  return (
    <aside className={`workspace-inspector ${open ? 'open' : ''} ${collapsed ? 'collapsed' : ''}`}>
      {!collapsed && (
        <div
          className="inspector-resize-handle"
          role="separator"
          aria-label="Resize workspace sidebar"
          aria-orientation="vertical"
          onPointerDown={(event) => {
            event.preventDefault();
            const handle = event.currentTarget;
            handle.classList.add('dragging');
            document.body.classList.add('resizing-inspector');
            const move = (pointerEvent: PointerEvent) => {
              onResize(Math.min(720, Math.max(260, window.innerWidth - pointerEvent.clientX)));
            };
            const stop = () => {
              handle.classList.remove('dragging');
              document.body.classList.remove('resizing-inspector');
              window.removeEventListener('pointermove', move);
              window.removeEventListener('pointerup', stop);
              window.removeEventListener('pointercancel', stop);
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', stop, { once: true });
            window.addEventListener('pointercancel', stop, { once: true });
          }}
        />
      )}
      {collapsed ? (
        <button type="button" className="inspector-expand" onClick={onToggleCollapsed} aria-label="Expand workspace sidebar">‹</button>
      ) : <>
      <div className="inspector-head">
        <div><span>Session workspace</span><strong>{referenceOpen ? referencePreview?.path : selectedDiff?.path ?? selected?.title ?? 'Artifacts'}</strong></div>
        <div className="inspector-head-actions">
          <button type="button" className="inspector-collapse" onClick={onToggleCollapsed} aria-label="Collapse workspace sidebar">›</button>
          <button type="button" className="inspector-close" onClick={onClose} aria-label="Close workspace sidebar">×</button>
        </div>
      </div>
      {referenceOpen && referencePreview ? (
        <>
          <button type="button" className="artifact-back" onClick={() => setReferenceOpen(false)}>
            Back to artifacts
          </button>
          <div className="reference-preview">
            <div>
              <strong>{requestedReference?.label || referencePreview.path}</strong>
              <code>{referencePreview.root}</code>
            </div>
            {referencePreview.error ? (
              <p className="reference-error">{referencePreview.error}</p>
            ) : referencePreview.content ? (
              <pre>
                <code>
                  {referencePreview.content.split(/\r?\n/).map((line, index) => (
                    <span
                      className={requestedReference?.line === index + 1 ? 'target' : ''}
                      key={index}
                    >
                      <b>{index + 1}</b><i>{line || ' '}</i>
                    </span>
                  ))}
                </code>
              </pre>
            ) : <div className="reference-loading">Loading referenced fileâ€¦</div>}
          </div>
        </>
      ) : selectedDiff ? (
        <>
          <button type="button" className="artifact-back" onClick={() => setSelectedDiff(undefined)}>← Review changes</button>
          <div className="diff-view">
            <div className="diff-summary">
              <span className={`file-status ${selectedDiff.status}`}>{selectedDiff.status.slice(0, 1).toUpperCase()}</span>
              <code>{selectedDiff.path}</code>
              <b>+{selectedDiff.additions}</b><i>−{selectedDiff.deletions}</i>
            </div>
            <div className="diff-code">
              {diffLines.map((line, index) => (
                <div className={`diff-line ${line.type}`} key={index}>
                  <span>{index + 1}</span><b>{line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' '}</b><code>{line.content || ' '}</code>
                </div>
              ))}
              {!diffLines.length && <div className="diff-empty">The previous file content is not available for this change.</div>}
            </div>
          </div>
        </>
      ) : selected ? (
        <>
          <button type="button" className="artifact-back" onClick={() => setSelectedId(undefined)}>← All artifacts</button>
          <div className="artifact-preview">
            {selected.diagram
              ? <DiagramCard diagram={selected.diagram} history={selected.diagramHistory} compact />
              : renderMarkdownLite(selected.content)}
          </div>
        </>
      ) : (
        <>
          <div className="inspector-tabs">
            <button type="button" className={tab === 'artifacts' ? 'active' : ''} onClick={() => setTab('artifacts')}>
              Artifacts <b>{artifacts.length}</b>
            </button>
            <button type="button" className={tab === 'changes' ? 'active' : ''} onClick={() => setTab('changes')}>
              Review <b>{reviews.length}</b>
            </button>
          </div>
          <div className="inspector-content">
            {tab === 'artifacts' && artifacts.map((artifact) => (
              <button type="button" className="artifact-row" key={artifact.id} onClick={() => setSelectedId(artifact.id)}>
                <span>{artifact.kind === 'Plan' ? '◇' : artifact.kind === 'Diagram' ? '◈' : 'M↓'}</span>
                <div><strong>{artifact.title}</strong><small>{artifact.kind} · Open preview</small></div>
                <i>›</i>
              </button>
            ))}
            {tab === 'changes' && reviews.map(({ message, review }) => (
              <ReviewChanges
                key={message.id}
                review={review}
                action={message.reviewAction}
                disabled={sending}
                onUndo={() => onUndo(message.id, review)}
                onFileSelect={setSelectedDiff}
              />
            ))}
            {tab === 'artifacts' && !artifacts.length && (
              <div className="inspector-empty"><span>◇</span><strong>No artifacts yet</strong><p>Markdown documents and plans from this project’s working directory will appear here.</p></div>
            )}
            {tab === 'changes' && !reviews.length && (
              <div className="inspector-empty"><span>⌘</span><strong>No changes to review</strong><p>Workspace edits reported by the agent will be collected here.</p></div>
            )}
          </div>
        </>
      )}</>}
    </aside>
  );
}
