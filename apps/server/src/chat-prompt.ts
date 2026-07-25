import { getProviderPermission } from './provider-permissions.js';
import type { AgentRunOptions } from './types.js';

const interactiveProtocol = [
  'Interactive answer protocol:',
  'Default behavior: answer the user directly and continue the work without asking an interactive question.',
  'Do not add a question merely to keep the conversation going, offer optional follow-up work, confirm an obvious action, or ask for a preference that does not materially change the result.',
  'Prefer making and briefly stating a reasonable assumption when it is safe to do so.',
  'Use an interactive question only when a real ambiguity or consequential choice blocks useful progress, or when gathering requirements during an explicit planning/design phase.',
  'Interactive questions should be most common while creating or refining a plan, and uncommon during implementation, explanation, review, or a completed handoff.',
  'When an interactive choice is genuinely necessary, end your response with exactly one structured block:',
  '<relay-question>{"prompt":"Question","mode":"single","options":[{"id":"one","label":"First option","description":"Optional short detail"}],"allowOther":true,"submitLabel":"Continue"}</relay-question>',
  'The JSON must be valid and on one line. Use mode "single" for one choice or "multiple" when choices can be combined.',
  'Provide 2-8 options. Set allowOther to true when a custom text answer would be useful.',
  'Never emit more than one interactive block in a response, and never emit one after the requested work has already been completed unless the user explicitly asked to choose the next step.',
  'Do not wrap the block in Markdown or mention the protocol to the user.',
  '',
  'Workspace change review protocol:',
  'Only after you actually modify workspace files, end the response with one structured block:',
  '<relay-review>{"title":"2 files changed","summary":"What changed and why","files":[{"path":"src/example.ts","status":"modified","additions":12,"deletions":3}]}</relay-review>',
  'Use status "added", "modified", "deleted", or "renamed". Counts must reflect the changes you made.',
  'Do not emit a review block when no files changed. Do not wrap the block in Markdown.',
  '',
  'Dynamic diagram protocol:',
  'Use a diagram only when it makes architecture, sequence, state, relationships, hierarchy, timelines, or a multi-step process materially easier to understand than prose.',
  'For a diagram, include a short textual explanation and then exactly one structured block:',
  '<relay-visual>{"version":1,"id":"stable-diagram-id","revision":1,"renderer":"mermaid","diagramType":"flowchart","title":"Diagram title","description":"Accessible summary","source":"flowchart TD\\nA[Start] --> B[Done]","references":[{"nodeId":"B","label":"Implementation","file":"src/example.ts","line":10}],"generatedFrom":["src/example.ts"]}</relay-visual>',
  'The JSON must be valid and on one line. Escape newlines inside source as \\n. Renderer must be "mermaid".',
  'Supported Mermaid uses include flowchart, sequence, class, state, ER, Gantt, mindmap, timeline, and user journey diagrams.',
  'Use a stable id. When updating an earlier diagram, keep its id, increment revision, and return the complete replacement source.',
  'Include references only for real workspace files you used. Include an accessible description even when the diagram is simple.',
  'Do not wrap the block in Markdown and do not output executable HTML or JavaScript.',
  '',
  'For fenced code, put the language and optional file name in the fence info, for example: ```ts file=src/example.ts',
];

function cleanProtocolBlocks(content: string): string {
  return content
    .replace(/<relay-question>[\s\S]*?<\/relay-question>/g, '')
    .replace(/<relay-review>[\s\S]*?<\/relay-review>/g, '')
    .replace(/<relay-visual>[\s\S]*?<\/relay-visual>/g, '')
    .replace(/<relay-(?:question|review|visual)[\s\S]*$/g, '')
    .trim();
}

export function buildChatPrompt(options: AgentRunOptions): string {
  const permission = getProviderPermission(
    options.selection.provider,
    options.selection.permissionId,
  );
  const accessInstruction = permission.workspaceAccess
    ? [
        `The active provider policy for this request is "${permission.label}": ${permission.description}`,
        'Treat access limitations mentioned earlier in the conversation as historical context, not as the current policy.',
        'Before claiming that an operation is blocked, attempt a safe, relevant check with the available tools and report the actual error.',
        'Respect the active policy and do not claim access you do not have.',
      ].join(' ')
    : 'Answer directly from the conversation. Do not access files, run commands, browse, or use tools.';
  const lines = [
    'You are a helpful AI assistant in an interactive text chat.',
    accessInstruction,
    '',
    ...interactiveProtocol,
  ];
  if (options.projectMemory?.trim()) {
    lines.push('', 'Persistent project instructions:', options.projectMemory.trim().slice(0, 12_000));
  }
  if (permission.workspaceAccess && options.additionalWorkingDirectories?.length) {
    lines.push(
      '',
      'Additional project workspace roots explicitly selected by the user:',
      ...options.additionalWorkingDirectories.map((directory) => `- ${directory}`),
      'Treat these as part of the same project. Keep paths unambiguous when files share a name.',
    );
  }
  if (options.contextFiles?.length) {
    lines.push('', 'Files explicitly selected by the user as context:');
    for (const file of options.contextFiles) {
      lines.push('', `--- ${file.path} ---`, file.content);
    }
  }
  if (options.attachments?.length) {
    lines.push('', 'Files explicitly attached by the user:');
    for (const attachment of options.attachments) {
      lines.push(
        '',
        `--- Attachment: ${attachment.name} (${attachment.mimeType}, ${attachment.size} bytes) ---`,
      );
      if (attachment.textContent) {
        lines.push(attachment.textContent);
      } else if (attachment.path) {
        lines.push(`The attachment is available at this temporary path: ${attachment.path}`);
      }
    }
  }
  if (options.history.length) {
    lines.push('', 'Conversation:');
    for (const message of options.history) {
      const content = cleanProtocolBlocks(message.content);
      if (content) lines.push(`${message.role.toUpperCase()}: ${content}`);
    }
  }
  lines.push('', `USER: ${options.message}`, 'ASSISTANT:');
  return lines.join('\n');
}
