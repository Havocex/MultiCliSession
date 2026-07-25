import { useState } from 'react';
import type { InteractionResponse } from './chatClient';

export interface InteractiveOption {
  id: string;
  label: string;
  description?: string;
}

export interface InteractiveQuestionData {
  prompt: string;
  mode: 'single' | 'multiple';
  options: InteractiveOption[];
  allowOther: boolean;
  submitLabel: string;
}

interface ParsedInteractiveContent {
  displayContent: string;
  question?: InteractiveQuestionData;
}

const openTag = '<relay-question>';
const closeTag = '</relay-question>';

export function parseInteractiveContent(content: string): ParsedInteractiveContent {
  const start = content.indexOf(openTag);
  if (start < 0) {
    const partialStart = content.indexOf('<relay-question');
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
    .replace(/<relay-question>[\s\S]*?<\/relay-question>/g, '')
    .replace(/<relay-question[\s\S]*$/g, '')
    .trim();

  try {
    const raw = JSON.parse(content.slice(start + openTag.length, end)) as Record<string, unknown>;
    const mode = raw.mode === 'multiple' ? 'multiple' : raw.mode === 'single' ? 'single' : undefined;
    const options = Array.isArray(raw.options)
      ? raw.options
          .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
          .map((item) => ({
            id: typeof item.id === 'string' ? item.id.trim() : '',
            label: typeof item.label === 'string' ? item.label.trim() : '',
            description: typeof item.description === 'string' ? item.description.trim() : undefined,
          }))
          .filter((item) => item.id && item.label)
          .slice(0, 8)
      : [];
    if (typeof raw.prompt !== 'string' || !raw.prompt.trim() || !mode || options.length < 2) {
      return { displayContent };
    }
    return {
      displayContent,
      question: {
        prompt: raw.prompt.trim(),
        mode,
        options,
        allowOther: raw.allowOther === true,
        submitLabel:
          typeof raw.submitLabel === 'string' && raw.submitLabel.trim()
            ? raw.submitLabel.trim()
            : 'Continue',
      },
    };
  } catch {
    return { displayContent };
  }
}

interface InteractiveQuestionProps {
  question: InteractiveQuestionData;
  response?: InteractionResponse;
  disabled?: boolean;
  onSubmit: (response: Omit<InteractionResponse, 'submittedAt'>) => void;
}

export function InteractiveQuestion({
  question,
  response,
  disabled = false,
  onSubmit,
}: InteractiveQuestionProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>(response?.selectedIds ?? []);
  const [otherSelected, setOtherSelected] = useState(Boolean(response?.otherText));
  const [otherText, setOtherText] = useState(response?.otherText ?? '');
  const locked = disabled || Boolean(response);
  const multiple = question.mode === 'multiple';

  const toggleOption = (optionId: string) => {
    if (locked) return;
    if (multiple) {
      setSelectedIds((current) =>
        current.includes(optionId)
          ? current.filter((id) => id !== optionId)
          : [...current, optionId],
      );
      return;
    }
    setSelectedIds([optionId]);
    setOtherSelected(false);
  };

  const selectOther = () => {
    if (locked) return;
    const next = !otherSelected;
    setOtherSelected(next);
    if (next && !multiple) setSelectedIds([]);
  };

  const canSubmit =
    selectedIds.length > 0 || (otherSelected && Boolean(otherText.trim()));

  const submit = () => {
    if (!canSubmit || locked) return;
    const selected = question.options.filter((option) => selectedIds.includes(option.id));
    onSubmit({
      selectedIds: selected.map((option) => option.id),
      labels: selected.map((option) => option.label),
      otherText: otherSelected && otherText.trim() ? otherText.trim() : undefined,
    });
  };

  return (
    <div className={`interactive-card ${response ? 'answered' : ''}`}>
      <div className="interactive-heading">
        <span className="interactive-spark">✦</span>
        <div>
          <strong>{question.prompt}</strong>
          <span>{multiple ? 'Select one or more options' : 'Select one option'}</span>
        </div>
      </div>

      <div className="interactive-options" role={multiple ? 'group' : 'radiogroup'}>
        {question.options.map((option) => {
          const checked = selectedIds.includes(option.id);
          return (
            <button
              type="button"
              key={option.id}
              className={`interactive-option ${checked ? 'selected' : ''}`}
              disabled={locked}
              aria-pressed={checked}
              onClick={() => toggleOption(option.id)}
            >
              <span className={`choice-control ${multiple ? 'checkbox' : 'radio'}`}>
                {checked && <span>{multiple ? '✓' : ''}</span>}
              </span>
              <span className="choice-copy">
                <strong>{option.label}</strong>
                {option.description && <small>{option.description}</small>}
              </span>
            </button>
          );
        })}

        {question.allowOther && (
          <div className={`interactive-other ${otherSelected ? 'selected' : ''}`}>
            <button
              type="button"
              className="other-toggle"
              disabled={locked}
              aria-pressed={otherSelected}
              onClick={selectOther}
            >
              <span className={`choice-control ${multiple ? 'checkbox' : 'radio'}`}>
                {otherSelected && <span>{multiple ? '✓' : ''}</span>}
              </span>
              <span>Other</span>
            </button>
            <input
              value={otherText}
              disabled={locked}
              aria-label="Custom answer"
              placeholder="Type your own answer…"
              onFocus={() => {
                setOtherSelected(true);
                if (!multiple) setSelectedIds([]);
              }}
              onChange={(event) => {
                setOtherText(event.target.value);
                setOtherSelected(true);
                if (!multiple) setSelectedIds([]);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && canSubmit) submit();
              }}
            />
          </div>
        )}
      </div>

      <div className="interactive-footer">
        {response ? (
          <span className="answer-confirmation">✓ Answer submitted</span>
        ) : (
          <>
            <span>
              {multiple && selectedIds.length
                ? `${selectedIds.length} selected`
                : 'You can change your choice before submitting'}
            </span>
            <button type="button" disabled={!canSubmit || locked} onClick={submit}>
              {question.submitLabel}
              <span>→</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
