/**
 * Shared full validation runner used by the CLI and guided setup.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  loadSkillDescriptions,
  runActivationCorpus,
  validateCorpus,
} from './activation-scorer.js';
import { validateEventLogs } from './event-logging.js';
import { loadAgenticLoopConfig, loadJsonFile } from './json.js';
import {
  SKILLS_SOURCE_DIRECTORY,
  describeToolkitAssetPath,
  resolveToolkitAssetLayout,
  resolveToolkitAssetPath,
} from './layout.js';
import { validateConfig } from './validate-config.js';
import {
  errorCount,
  printReport,
  validateSkills,
  warningCount,
} from './validate-skills.js';

function writeLine(output, line = '') {
  output.write(`${line}\n`);
}

function formatValidationOptions(options = {}) {
  const {
    adapters = [],
    output = process.stdout,
  } = options;

  return {
    adapters: Array.isArray(adapters) ? adapters : [adapters].filter(Boolean),
    output,
  };
}

/**
 * Run the same validation surface as `agenticloop validate`.
 *
 * @param {string} target Absolute or cwd-relative target directory.
 * @param {object} [options]
 * @param {string[]} [options.adapters] Force adapter validation.
 * @param {NodeJS.WritableStream} [options.output] Output stream.
 * @returns {{
 *   totalErrors: number,
 *   totalWarnings: number,
 *   skillReport: object,
 *   activationErrors: string[],
 *   activationWarnings: string[],
 *   configErrors: string[],
 *   configWarnings: string[],
 *   eventLogErrors: string[],
 *   eventLogWarnings: string[],
 * }}
 */
export function runValidation(target, options = {}) {
  const { adapters, output } = formatValidationOptions(options);
  const alCfgPath = join(target, 'agenticloop.json');
  const assetLayout = resolveToolkitAssetLayout(target);

  let skillsDir = resolveToolkitAssetPath(target, SKILLS_SOURCE_DIRECTORY, assetLayout);
  let skillsDirDisplay = describeToolkitAssetPath(SKILLS_SOURCE_DIRECTORY, assetLayout);
  let alConfig = null;

  if (existsSync(alCfgPath)) {
    try {
      alConfig = loadAgenticLoopConfig(alCfgPath);
      skillsDir = join(target, alConfig.skills?.sourceDirectory ?? SKILLS_SOURCE_DIRECTORY);
      skillsDirDisplay = (alConfig.skills?.sourceDirectory ?? SKILLS_SOURCE_DIRECTORY).replace(/\\/g, '/');
    } catch {
      // Handled by validateConfig below.
    }
  }

  const skillReport = validateSkills(skillsDir);
  printReport(skillReport, skillsDir, target, output);

  let activationErrors = [];
  let activationWarnings = [];
  const corpusPath = join(skillsDir, 'agenticloop-tests.json');
  if (existsSync(corpusPath)) {
    let corpus;
    try {
      corpus = loadJsonFile(corpusPath);
    } catch (e) {
      activationErrors.push(`agenticloop-tests.json parse error: ${e.message}`);
    }

    if (corpus) {
      const { skills: skillDescs, errors: loadErrors } = loadSkillDescriptions(skillsDir);
      activationErrors.push(...loadErrors);
      if (loadErrors.length === 0) {
        const corpusValidation = validateCorpus(skillDescs, corpus);
        activationErrors.push(...corpusValidation.errors);
        activationWarnings.push(...corpusValidation.warnings);
        if (corpusValidation.errors.length === 0) {
          const { passed, failures } = runActivationCorpus(skillDescs, corpus);
          if (!passed) {
            activationErrors.push(...failures);
          }
        }
      }
    }
  } else {
    activationErrors.push(`Missing activation corpus: ${skillsDirDisplay}/agenticloop-tests.json`);
  }

  const hasActivationIssues = activationErrors.length > 0 || activationWarnings.length > 0;
  if (!hasActivationIssues) {
    writeLine(output);
    writeLine(output, '='.repeat(70));
    writeLine(output, ' Activation Corpus - OK');
    writeLine(output, '='.repeat(70));
    writeLine(output);
  } else {
    writeLine(output);
    writeLine(output, '='.repeat(70));
    writeLine(output, ' Activation Corpus');
    writeLine(output, '='.repeat(70));
    for (const e of activationErrors) writeLine(output, `  ERROR: ${e}`);
    for (const w of activationWarnings) writeLine(output, `  WARN:  ${w}`);
    writeLine(output);
  }

  const { errors: configErrors, warnings: configWarnings } = validateConfig(target, { adapters });
  const hasConfigIssues = configErrors.length > 0 || configWarnings.length > 0;
  if (hasConfigIssues) {
    writeLine(output, '='.repeat(70));
    writeLine(output, ' Config Validation');
    writeLine(output, '='.repeat(70));
    for (const e of configErrors) writeLine(output, `  ERROR: ${e}`);
    for (const w of configWarnings) writeLine(output, `  WARN:  ${w}`);
    writeLine(output);
  }

  const eventLogResult = validateEventLogs(target);
  const eventLogErrors = eventLogResult.exists ? eventLogResult.errors : [];
  const eventLogWarnings = eventLogResult.exists ? eventLogResult.warnings : [];
  if (eventLogResult.exists) {
    const hasEventLogIssues = eventLogErrors.length > 0 || eventLogWarnings.length > 0;
    writeLine(output, '='.repeat(70));
    writeLine(output, hasEventLogIssues ? ' Event Logs' : ' Event Logs - OK');
    writeLine(output, '='.repeat(70));
    writeLine(output, `  directory: ${eventLogResult.directory}`);
    if (hasEventLogIssues) {
      for (const e of eventLogErrors) writeLine(output, `  ERROR: ${e}`);
      for (const w of eventLogWarnings) writeLine(output, `  WARN:  ${w}`);
    } else {
      writeLine(output, `  OK: ${eventLogResult.fileCount} file(s), ${eventLogResult.eventCount} event(s) validated`);
    }
    writeLine(output);
  }

  const totalErrors = errorCount(skillReport) + configErrors.length + activationErrors.length + eventLogErrors.length;
  const totalWarnings = warningCount(skillReport) + configWarnings.length + activationWarnings.length + eventLogWarnings.length;

  return {
    totalErrors,
    totalWarnings,
    skillReport,
    activationErrors,
    activationWarnings,
    configErrors,
    configWarnings,
    eventLogErrors,
    eventLogWarnings,
  };
}
