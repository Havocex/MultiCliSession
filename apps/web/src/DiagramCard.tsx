import { useEffect, useMemo, useRef, useState } from 'react';

export interface DiagramReference {
  nodeId?: string;
  label?: string;
  file: string;
  line?: number;
}

export interface DiagramData {
  version: 1;
  id: string;
  revision: number;
  renderer: 'mermaid';
  diagramType?: string;
  title: string;
  description?: string;
  source: string;
  references: DiagramReference[];
  generatedFrom: string[];
}

interface ParsedDiagramContent {
  displayContent: string;
  diagram?: DiagramData;
  invalidDiagram?: boolean;
}

const openTag = '<relay-visual>';
const closeTag = '</relay-visual>';

export function parseDiagramContent(content: string): ParsedDiagramContent {
  const start = content.indexOf(openTag);
  if (start < 0) {
    const partialStart = content.indexOf('<relay-visual');
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
    .replace(/<relay-visual>[\s\S]*?<\/relay-visual>/g, '')
    .replace(/<relay-visual[\s\S]*$/g, '')
    .trim();
  try {
    const raw = JSON.parse(content.slice(start + openTag.length, end)) as Record<string, unknown>;
    if (
      raw.renderer !== 'mermaid' ||
      typeof raw.source !== 'string' ||
      !raw.source.trim() ||
      raw.source.length > 100_000
    ) {
      return { displayContent, invalidDiagram: true };
    }
    const fallbackId = `diagram-${Math.abs(hashText(raw.source))}`;
    const rawId = typeof raw.id === 'string' ? raw.id.trim() : '';
    const references = Array.isArray(raw.references)
      ? raw.references.flatMap((value): DiagramReference[] => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
          const reference = value as Record<string, unknown>;
          if (typeof reference.file !== 'string' || !reference.file.trim()) return [];
          return [{
            nodeId: typeof reference.nodeId === 'string' ? reference.nodeId.slice(0, 100) : undefined,
            label: typeof reference.label === 'string' ? reference.label.slice(0, 200) : undefined,
            file: reference.file.trim().slice(0, 2_000),
            line: typeof reference.line === 'number' && reference.line > 0
              ? Math.round(reference.line)
              : undefined,
          }];
        }).slice(0, 40)
      : [];
    const generatedFrom = Array.isArray(raw.generatedFrom)
      ? raw.generatedFrom
          .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
          .map((value) => value.trim().slice(0, 2_000))
          .slice(0, 40)
      : [];
    return {
      displayContent,
      diagram: {
        version: 1,
        id: (rawId || fallbackId).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 100),
        revision:
          typeof raw.revision === 'number' && Number.isInteger(raw.revision) && raw.revision > 0
            ? raw.revision
            : 1,
        renderer: 'mermaid',
        diagramType:
          typeof raw.diagramType === 'string' ? raw.diagramType.trim().slice(0, 60) : undefined,
        title:
          typeof raw.title === 'string' && raw.title.trim()
            ? raw.title.trim().slice(0, 200)
            : 'Diagram',
        description:
          typeof raw.description === 'string' ? raw.description.trim().slice(0, 2_000) : undefined,
        source: raw.source.trim(),
        references,
        generatedFrom,
      },
    };
  } catch {
    return { displayContent, invalidDiagram: true };
  }
}

function hashText(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return hash;
}

let mermaidInitialized = false;

async function renderMermaid(source: string, renderId: string): Promise<string> {
  const { default: mermaid } = await import('mermaid');
  if (!mermaidInitialized) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'dark',
      suppressErrorRendering: true,
      flowchart: { htmlLabels: false, useMaxWidth: true },
      sequence: { useMaxWidth: true },
    });
    mermaidInitialized = true;
  }
  const result = await mermaid.render(renderId, source);
  return result.svg;
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function safeFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*]+/g, '-').trim() || 'diagram';
}

export function DiagramCard({
  diagram,
  history = [],
  compact = false,
  disabled = false,
  onRequestUpdate,
  onOpenReference,
}: {
  diagram: DiagramData;
  history?: DiagramData[];
  compact?: boolean;
  disabled?: boolean;
  onRequestUpdate?: (instruction: string, diagram: DiagramData, immediate?: boolean) => void;
  onOpenReference?: (reference: DiagramReference) => void;
}) {
  const versions = useMemo(() => {
    const byRevision = new Map<number, DiagramData>();
    for (const item of [...history, diagram]) byRevision.set(item.revision, item);
    return [...byRevision.values()].sort((left, right) => left.revision - right.revision);
  }, [diagram, history]);
  const [revision, setRevision] = useState(diagram.revision);
  const selected = versions.find((item) => item.revision === revision) ?? diagram;
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [scale, setScale] = useState(1);
  const [copied, setCopied] = useState(false);
  const renderSequence = useRef(0);

  useEffect(() => {
    if (versions.some((item) => item.revision === diagram.revision)) {
      setRevision(diagram.revision);
    }
  }, [diagram.id, diagram.revision]);

  useEffect(() => {
    const sequence = ++renderSequence.current;
    setLoading(true);
    setError('');
    setSvg('');
    void renderMermaid(
      selected.source,
      `relay-diagram-${selected.id.replace(/[^a-zA-Z0-9_-]/g, '-')}-${sequence}`,
    )
      .then((nextSvg) => {
        if (renderSequence.current === sequence) setSvg(nextSvg);
      })
      .catch((nextError) => {
        if (renderSequence.current === sequence) {
          setError(nextError instanceof Error ? nextError.message : 'The diagram could not be rendered.');
        }
      })
      .finally(() => {
        if (renderSequence.current === sequence) setLoading(false);
      });
  }, [selected.id, selected.revision, selected.source]);

  useEffect(() => {
    if (!fullscreen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [fullscreen]);

  const copySource = async () => {
    await navigator.clipboard.writeText(selected.source);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_400);
  };
  const exportSvg = () => {
    if (!svg) return;
    downloadBlob(
      new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }),
      `${safeFileName(selected.title)}.svg`,
    );
  };
  const exportPng = async () => {
    if (!svg) return;
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('Could not rasterize this diagram.'));
        image.src = url;
      });
      const width = Math.max(640, image.naturalWidth || 1_000);
      const height = Math.max(360, image.naturalHeight || 600);
      const canvas = document.createElement('canvas');
      canvas.width = width * 2;
      canvas.height = height * 2;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas is unavailable.');
      context.scale(2, 2);
      context.fillStyle = '#0d0c12';
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (png) downloadBlob(png, `${safeFileName(selected.title)}.png`);
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const card = (
    <section className={`diagram-card ${compact ? 'compact' : ''} ${fullscreen ? 'fullscreen' : ''}`}>
      <header>
        <div className="diagram-title">
          <span>◇</span>
          <div>
            <strong>{selected.title}</strong>
            <small>
              {selected.diagramType || 'Mermaid'} · revision {selected.revision}
              {selected.generatedFrom.length ? ` · ${selected.generatedFrom.length} sources` : ''}
            </small>
          </div>
        </div>
        <div className="diagram-header-actions">
          {versions.length > 1 && (
            <select
              value={selected.revision}
              aria-label="Diagram revision"
              onChange={(event) => setRevision(Number(event.target.value))}
            >
              {versions.map((item) => (
                <option key={item.revision} value={item.revision}>v{item.revision}</option>
              ))}
            </select>
          )}
          <button type="button" onClick={() => setSourceOpen((value) => !value)}>
            {sourceOpen ? 'Diagram' : 'Source'}
          </button>
          {!compact && <button type="button" onClick={() => setFullscreen((value) => !value)}>
            {fullscreen ? 'Close' : 'Fullscreen'}
          </button>}
        </div>
      </header>

      {selected.description && <p className="diagram-description">{selected.description}</p>}

      {sourceOpen ? (
        <pre className="diagram-source"><code>{selected.source}</code></pre>
      ) : (
        <div className="diagram-stage">
          {loading && <div className="diagram-skeleton"><i /><i /><i /></div>}
          {error && (
            <div className="diagram-error" role="alert">
              <strong>Diagram syntax needs attention</strong>
              <span>{error}</span>
              {onRequestUpdate && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onRequestUpdate(
                    `Repair the Mermaid syntax for diagram "${selected.title}" without changing its intended meaning.`,
                    selected,
                    true,
                  )}
                >
                  Ask agent to repair
                </button>
              )}
            </div>
          )}
          {svg && (
            <div
              className="diagram-svg"
              style={{ transform: `scale(${scale})` }}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          )}
        </div>
      )}

      {!sourceOpen && !error && (
        <div className="diagram-zoom">
          <button type="button" aria-label="Zoom out" onClick={() => setScale((value) => Math.max(.5, value - .15))}>−</button>
          <button type="button" onClick={() => setScale(1)}>{Math.round(scale * 100)}%</button>
          <button type="button" aria-label="Zoom in" onClick={() => setScale((value) => Math.min(2.5, value + .15))}>＋</button>
        </div>
      )}

      {selected.references.length > 0 && (
        <div className="diagram-references">
          <small>Linked code</small>
          <div>
            {selected.references.map((reference, index) => (
              <button
                type="button"
                key={`${reference.file}-${reference.line ?? 0}-${index}`}
                onClick={() => onOpenReference?.(reference)}
              >
                <code>{reference.label || reference.file}{reference.line ? `:${reference.line}` : ''}</code>
              </button>
            ))}
          </div>
        </div>
      )}

      <footer>
        <span>{selected.generatedFrom.length ? `Generated from ${selected.generatedFrom.join(', ')}` : 'Generated from this conversation'}</span>
        <div>
          <button type="button" onClick={() => void copySource()}>{copied ? '✓ Copied' : 'Copy source'}</button>
          <button type="button" disabled={!svg} onClick={exportSvg}>SVG</button>
          <button type="button" disabled={!svg} onClick={() => void exportPng()}>PNG</button>
          {onRequestUpdate && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onRequestUpdate(
                `Update diagram "${selected.title}" based on my next instruction. Keep the same diagram id "${selected.id}" and increment revision ${selected.revision} to ${selected.revision + 1}.`,
                selected,
                false,
              )}
            >
              Update with agent
            </button>
          )}
        </div>
      </footer>
    </section>
  );

  return fullscreen
    ? <div className="diagram-fullscreen-backdrop" role="dialog" aria-modal="true" aria-label={selected.title}>{card}</div>
    : card;
}
