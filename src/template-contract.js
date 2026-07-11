import { existsSync, readFileSync } from 'node:fs';
import { parseFrontmatter } from './frontmatter.js';
import { hasMarkdownHeading, markdownLines, markdownSection, parseAtxHeading } from './markdown.js';
import {
  BACKENDS_SOURCE_DIRECTORY,
  DECISION_RECORD_TEMPLATE_RELATIVE_PATH,
  IMPROVEMENT_PROPOSAL_RISK_LEVELS,
  IMPROVEMENT_PROPOSAL_SECTION_HEADINGS,
  IMPROVEMENT_PROPOSAL_STATUSES,
  IMPROVEMENT_PROPOSAL_TARGET_SURFACES,
  IMPROVEMENT_PROPOSAL_TEMPLATE_RELATIVE_PATH,
  PROJECT_SCAFFOLD_RELATIVE_PATH,
  TASK_OPTIONAL_SECTION_HEADINGS,
  TASK_RECORD_TEMPLATE_RELATIVE_PATH,
  TASK_REQUIRED_SECTION_HEADINGS,
  TRACE_SUMMARY_BULLET_LABELS,
  WORK_UNIT_SUMMARY_SECTION_HEADINGS,
  WORK_UNIT_SUMMARY_STATUSES,
  WORK_UNIT_SUMMARY_TEMPLATE_RELATIVE_PATH,
  WORK_UNIT_SUMMARY_UNITS,
  describeToolkitAssetPath,
  resolveToolkitAssetLayout,
  resolveToolkitAssetPath,
} from './layout.js';

const TEMPLATE_CONSUMER_RELATIVE_PATHS = Object.freeze([
  `${BACKENDS_SOURCE_DIRECTORY}/files.md`,
  `${BACKENDS_SOURCE_DIRECTORY}/github.md`,
]);

export const REQUIRED_TEMPLATE_RELATIVE_PATHS = Object.freeze([
  PROJECT_SCAFFOLD_RELATIVE_PATH,
  TASK_RECORD_TEMPLATE_RELATIVE_PATH,
  WORK_UNIT_SUMMARY_TEMPLATE_RELATIVE_PATH,
  DECISION_RECORD_TEMPLATE_RELATIVE_PATH,
  IMPROVEMENT_PROPOSAL_TEMPLATE_RELATIVE_PATH,
]);

function renderHeadingBlock(headings) {
  return headings.join('\n');
}

function indexOfHeading(content, heading, startIndex = 0) {
  const wanted = parseAtxHeading(heading);
  if (!wanted) return -1;
  for (const item of markdownLines(content)) {
    if (!item.live || item.line - 1 < startIndex) continue;
    const parsed = parseAtxHeading(item.raw);
    if (parsed && parsed.level === wanted.level && parsed.text === wanted.text) return item.line - 1;
  }
  return -1;
}

function validateOrderedHeadings(content, headings, label) {
  const errors = [];
  let cursor = 0;
  for (const heading of headings) {
    const position = indexOfHeading(content, heading, cursor);
    if (position === -1) {
      errors.push(`${label} missing required heading '${heading}'`);
      continue;
    }
    cursor = position + 1;
  }
  return errors;
}

function validateTraceBulletLabels(content, relPath) {
  if (!hasMarkdownHeading(content, '## Trace')) {
    return [];
  }
  const traceSection = markdownSection(content, '## Trace')?.body ?? '';
  const errors = [];
  for (const label of TRACE_SUMMARY_BULLET_LABELS) {
    if (!traceSection.includes(`**${label}**`)) {
      errors.push(`${relPath} '## Trace' section missing required bullet label '${label}'`);
    }
  }
  return errors;
}

function frontmatterString(value) {
  if (typeof value === 'string') return value.trim();
  return '';
}

function validateWorkUnitSummaryFrontmatter(content, relPath) {
  const errors = [];
  const [frontmatter] = parseFrontmatter(content);

  if (frontmatter === null) {
    return [`${relPath} missing YAML frontmatter`];
  }

  const summaryUnit = frontmatterString(frontmatter.summary_unit);
  const scopeRef = frontmatterString(frontmatter.scope_ref);
  const status = frontmatterString(frontmatter.status);

  if (!summaryUnit) {
    errors.push(`${relPath} missing required frontmatter field 'summary_unit'`);
  } else if (!WORK_UNIT_SUMMARY_UNITS.includes(summaryUnit)) {
    errors.push(
      `${relPath} frontmatter field 'summary_unit' must be one of: ${WORK_UNIT_SUMMARY_UNITS.join(', ')}`
    );
  }

  if (!scopeRef) {
    errors.push(`${relPath} missing required frontmatter field 'scope_ref'`);
  }

  if (!status) {
    errors.push(`${relPath} missing required frontmatter field 'status'`);
  } else if (!WORK_UNIT_SUMMARY_STATUSES.includes(status)) {
    errors.push(
      `${relPath} frontmatter field 'status' must be one of: ${WORK_UNIT_SUMMARY_STATUSES.join(', ')}`
    );
  }

  return errors;
}

function validateImprovementProposalFrontmatter(content, relPath) {
  const errors = [];
  const [frontmatter] = parseFrontmatter(content);

  if (frontmatter === null) {
    return [`${relPath} missing YAML frontmatter`];
  }

  const improvementId = frontmatterString(frontmatter.improvement_id);
  const date = frontmatterString(frontmatter.date);
  const status = frontmatterString(frontmatter.status);
  const riskLevel = frontmatterString(frontmatter.risk_level);
  const targetSurface = frontmatterString(frontmatter.target_surface);
  const requiresChangeRequest = frontmatter.requires_change_request;
  const requiresChangeRequestTruthy = requiresChangeRequest === true || requiresChangeRequest === 'true';

  if (!improvementId) {
    errors.push(`${relPath} missing required frontmatter field 'improvement_id'`);
  }

  if (!date) {
    errors.push(`${relPath} missing required frontmatter field 'date'`);
  }

  if (!status) {
    errors.push(`${relPath} missing required frontmatter field 'status'`);
  } else if (!IMPROVEMENT_PROPOSAL_STATUSES.includes(status)) {
    errors.push(
      `${relPath} frontmatter field 'status' must be one of: ${IMPROVEMENT_PROPOSAL_STATUSES.join(', ')}`
    );
  }

  if (!riskLevel) {
    errors.push(`${relPath} missing required frontmatter field 'risk_level'`);
  } else if (!IMPROVEMENT_PROPOSAL_RISK_LEVELS.includes(riskLevel)) {
    errors.push(
      `${relPath} frontmatter field 'risk_level' must be one of: ${IMPROVEMENT_PROPOSAL_RISK_LEVELS.join(', ')}`
    );
  }

  if (!targetSurface) {
    errors.push(`${relPath} missing required frontmatter field 'target_surface'`);
  } else if (!IMPROVEMENT_PROPOSAL_TARGET_SURFACES.includes(targetSurface)) {
    errors.push(
      `${relPath} frontmatter field 'target_surface' must be one of: ${IMPROVEMENT_PROPOSAL_TARGET_SURFACES.join(', ')}`
    );
  }

  if (riskLevel === 'high' && !requiresChangeRequestTruthy) {
    errors.push(
      `${relPath} risk_level 'high' requires 'requires_change_request: true'`
    );
  }

  if (Object.prototype.hasOwnProperty.call(frontmatter, 'promotion_tier')) {
    errors.push(`${relPath} must not contain 'promotion_tier' frontmatter field`);
  }

  return errors;
}

export function renderTaskRecordRequiredSectionBlock() {
  return renderHeadingBlock(TASK_REQUIRED_SECTION_HEADINGS);
}

export function renderTaskRecordOptionalSectionBlock() {
  return renderHeadingBlock(TASK_OPTIONAL_SECTION_HEADINGS);
}

export function renderWorkUnitSummarySectionBlock() {
  return renderHeadingBlock(WORK_UNIT_SUMMARY_SECTION_HEADINGS);
}

export function validateCanonicalTemplates(repoRoot, assetLayout = resolveToolkitAssetLayout(repoRoot)) {
  const errors = [];
  const warnings = [];

  if (assetLayout.kind === 'absent') {
    return { errors, warnings };
  }

  for (const relPath of REQUIRED_TEMPLATE_RELATIVE_PATHS) {
    if (!existsSync(resolveToolkitAssetPath(repoRoot, relPath, assetLayout))) {
      errors.push(`Canonical template not found: ${describeToolkitAssetPath(relPath, assetLayout)}`);
    }
  }

  const taskTemplatePath = resolveToolkitAssetPath(repoRoot, TASK_RECORD_TEMPLATE_RELATIVE_PATH, assetLayout);
  const taskTemplateLabel = describeToolkitAssetPath(TASK_RECORD_TEMPLATE_RELATIVE_PATH, assetLayout);
  if (existsSync(taskTemplatePath)) {
    const text = readFileSync(taskTemplatePath, 'utf-8');
    errors.push(...validateOrderedHeadings(text, TASK_REQUIRED_SECTION_HEADINGS, taskTemplateLabel));
    for (const heading of TASK_OPTIONAL_SECTION_HEADINGS) {
      if (!hasMarkdownHeading(text, heading)) {
        warnings.push(`${taskTemplateLabel} is missing optional section example '${heading}'`);
      }
    }
  }

  const workUnitTemplatePath = resolveToolkitAssetPath(
    repoRoot,
    WORK_UNIT_SUMMARY_TEMPLATE_RELATIVE_PATH,
    assetLayout
  );
  const workUnitTemplateLabel = describeToolkitAssetPath(
    WORK_UNIT_SUMMARY_TEMPLATE_RELATIVE_PATH,
    assetLayout
  );
  if (existsSync(workUnitTemplatePath)) {
    const text = readFileSync(workUnitTemplatePath, 'utf-8');
    errors.push(...validateWorkUnitSummaryFrontmatter(text, workUnitTemplateLabel));
    errors.push(...validateOrderedHeadings(text, WORK_UNIT_SUMMARY_SECTION_HEADINGS, workUnitTemplateLabel));
    errors.push(...validateTraceBulletLabels(text, workUnitTemplateLabel));
  }

  const improvementProposalTemplatePath = resolveToolkitAssetPath(
    repoRoot,
    IMPROVEMENT_PROPOSAL_TEMPLATE_RELATIVE_PATH,
    assetLayout
  );
  const improvementProposalTemplateLabel = describeToolkitAssetPath(
    IMPROVEMENT_PROPOSAL_TEMPLATE_RELATIVE_PATH,
    assetLayout
  );
  if (existsSync(improvementProposalTemplatePath)) {
    const text = readFileSync(improvementProposalTemplatePath, 'utf-8');
    errors.push(...validateImprovementProposalFrontmatter(text, improvementProposalTemplateLabel));
    errors.push(...validateOrderedHeadings(text, IMPROVEMENT_PROPOSAL_SECTION_HEADINGS, improvementProposalTemplateLabel));
  }

  for (const relPath of TEMPLATE_CONSUMER_RELATIVE_PATHS) {
    const consumerPath = resolveToolkitAssetPath(repoRoot, relPath, assetLayout);
    if (!existsSync(consumerPath)) {
      continue;
    }
    const text = readFileSync(consumerPath, 'utf-8');
    const copiedLabels = TRACE_SUMMARY_BULLET_LABELS
      .filter(label => text.includes(`- **${label}**`));
    if (copiedLabels.length > 0) {
      errors.push(
        `${describeToolkitAssetPath(relPath, assetLayout)} embeds trace-summary bullet labels (${copiedLabels.join(', ')}); reference ${describeToolkitAssetPath(WORK_UNIT_SUMMARY_TEMPLATE_RELATIVE_PATH, assetLayout)} instead`
      );
    }
  }

  return { errors, warnings };
}
