export const DEFAULT_TITLE_PREFIX_REGEX = '^\\s*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\\b';
export const DEFAULT_TASK_LABEL_TEMPLATE = 'task:{taskId}';

export const STANDARD_GITHUB_LABEL_DEFS = [
  {
    key: 'agentReady',
    defaultName: 'agent-ready',
    description: 'Agentic Loop task record ready for implementation',
    color: '0E8A16',
  },
  {
    key: 'blocked',
    defaultName: 'blocked',
    description: 'Agentic Loop task is blocked',
    color: 'B60205',
  },
  {
    key: 'approved',
    defaultName: 'approved',
    description: 'Agentic Loop change request approved',
    color: '5319E7',
  },
  {
    key: 'typeImpl',
    defaultName: 'type:impl',
    description: 'Agentic Loop implementation task',
    color: '1D76DB',
  },
  {
    key: 'typeChangeRequest',
    defaultName: 'type:change-request',
    description: 'Agentic Loop locked-decision change request',
    color: 'FBCA04',
  },
];

export const DEFAULT_GROUP_LABEL_TEMPLATES = {
  flat: 'group:{groupId}',
  phase: 'phase:{groupId}',
  milestone: 'milestone:{groupId}',
  epic: 'epic:{groupId}',
  custom: 'group:{groupId}',
};

export function applyTemplate(template, values) {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) => {
    return values[key] ?? match;
  });
}

export function resolveGithubLabelNames(config) {
  const overrides = config?.backends?.github?.labels ?? {};
  return Object.fromEntries(
    STANDARD_GITHUB_LABEL_DEFS.map(def => [def.key, overrides[def.key] ?? def.defaultName])
  );
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function templateCaptureRegex(template, tokenName) {
  const token = `{${tokenName}}`;
  const index = template.indexOf(token);
  if (index === -1) return null;

  const prefix = escapeRegex(template.slice(0, index));
  const suffix = escapeRegex(template.slice(index + token.length));
  return new RegExp(`^${prefix}(.+?)${suffix}$`);
}

export function extractTaskIdFromLabel(labelName, taskLabelTemplate = DEFAULT_TASK_LABEL_TEMPLATE) {
  if (typeof labelName !== 'string' || typeof taskLabelTemplate !== 'string') return null;
  const matcher = templateCaptureRegex(taskLabelTemplate, 'taskId');
  if (!matcher) return null;
  return labelName.match(matcher)?.[1] ?? null;
}

export function extractTaskIdFromTitle(title, titlePrefixRegex = DEFAULT_TITLE_PREFIX_REGEX) {
  if (typeof title !== 'string' || typeof titlePrefixRegex !== 'string') return null;

  try {
    const match = new RegExp(titlePrefixRegex).exec(title);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}
