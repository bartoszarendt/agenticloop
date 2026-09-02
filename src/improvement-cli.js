/**
 * `agenticloop improvement` - bounded, human-reviewed improvement proposals.
 *
 *   new     create one validated proposal (serious incidents need no repetition)
 *   lint    validate proposals against the canonical template rules
 *   status  list proposals and their statuses
 */

import { createIo, resolveCliTarget, EXIT_USAGE } from './cli-io.js';
import { readFileSync } from 'node:fs';
import { COMMAND_REGISTRY, parseCommandArgs, suggestName } from './cli-registry.js';
import { buildCliDurableReferenceContext } from './durable-refs.js';
import {
  createImprovementProposal,
  buildToolkitEscalationProposal,
  listImprovementProposals,
  parseImprovementProposal,
  validateImprovementProposal,
  validateToolkitEscalationProposal,
} from './improvement.js';
import { loadProjectMap, PROJECT_MAP_DEFAULTS } from './project-map.js';
import { executeMutationBatch, resolveTargetPath } from './fs-mutation-kernel.js';

function projectConfig(target) {
  return loadProjectMap(target)?.config ?? PROJECT_MAP_DEFAULTS;
}

function optionString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function optionList(value) {
  if (Array.isArray(value)) {
    return value.flatMap(item => String(item ?? '').split(',')).map(item => item.trim()).filter(Boolean);
  }
  return optionString(value).split(',').map(item => item.trim()).filter(Boolean);
}

/**
 * @param {string[]} args
 * @param {object} [io]
 * @returns {Promise<number>}
 */
export async function cmdImprovement(args, io = createIo()) {
  const sub = args[0];
  const SUBCOMMANDS = COMMAND_REGISTRY.improvement.subcommands;
  if (!sub || !SUBCOMMANDS[sub]) {
    const suggestion = sub ? suggestName(sub, Object.keys(SUBCOMMANDS)) : null;
    io.err(suggestion
      ? `improvement: unknown subcommand '${sub}'. Did you mean '${suggestion}'?`
      : 'improvement requires a subcommand: new, lint, status, propose-toolkit-escalation.');
    io.err('Run "agenticloop help improvement" for usage.');
    return EXIT_USAGE;
  }
  const { opts, positional } = parseCommandArgs(`improvement ${sub}`, SUBCOMMANDS[sub], args.slice(1));
  const target = resolveCliTarget(io, opts.target);
  // One command-local durable-reference context: audits, tasks, decisions,
  // markers, and proposals are resolved against live backend state, with at
  // most one GitHub inventory read per command.
  const refContext = buildCliDurableReferenceContext(target, projectConfig(target), io);

  try {
    if (sub === 'new') {
      const result = createImprovementProposal(target, {
        title: optionString(opts.title),
        sourceRefs: optionList(opts.sourceRef),
        targetSurface: optionString(opts.targetSurface),
        targetPath: optionString(opts.targetPath),
        riskLevel: optionString(opts.riskLevel),
        failurePattern: optionString(opts.failurePattern) || undefined,
        evidence: optionString(opts.evidence) || undefined,
        proposedChange: optionString(opts.proposedChange) || undefined,
        refContext,
      });
      if (!result.ok) {
        for (const error of result.errors) io.err(error);
        return 1;
      }
      if (opts.json) {
        io.out(JSON.stringify({ improvement_id: result.improvementId, file: result.relPath }, null, 2));
      } else {
        io.out(`Created ${result.relPath}`);
        io.out('  Proposal-only: the target surface is unchanged and promotion stays human-reviewed.');
      }
      return 0;
    }

    if (sub === 'lint') {
      const selector = positional[0];
      const entries = listImprovementProposals(target)
        .filter(entry => !selector || entry.improvementId === selector);
      if (selector && entries.length === 0) {
        io.err(`Improvement proposal not found: ${selector}`);
        return 1;
      }
      const results = entries.map(entry => ({
        file: entry.relPath,
        errors: validateImprovementProposal(entry.content, entry.relPath, { refContext }),
      }));
      const errors = results.flatMap(result => result.errors);
      if (opts.json) {
        io.out(JSON.stringify(results, null, 2));
      } else if (errors.length === 0) {
        io.out(entries.length === 0 ? 'No improvement proposals found.' : 'Improvement proposals: ok');
      } else {
        for (const result of results) {
          for (const error of result.errors) io.out(`${result.file}: ERROR ${error}`);
        }
      }
      return errors.length > 0 ? 1 : 0;
    }

    if (sub === 'status') {
      const entries = listImprovementProposals(target).map(entry => ({
        improvement_id: entry.improvementId,
        file: entry.relPath,
        ...(() => {
          const proposal = parseImprovementProposal(entry.content);
          return {
            status: proposal.status,
            risk_level: proposal.riskLevel,
            requires_change_request: proposal.requiresChangeRequest,
            target_surface: proposal.targetSurface,
            source_refs: proposal.sourceRefs,
          };
        })(),
      }));
      if (opts.json) {
        io.out(JSON.stringify(entries, null, 2));
      } else if (entries.length === 0) {
        io.out('No improvement proposals found.');
      } else {
        for (const entry of entries) {
          io.out(`${entry.improvement_id}  ${entry.status}  risk:${entry.risk_level}  ${entry.file}`);
        }
      }
      return 0;
    }

    if (sub === 'propose-toolkit-escalation') {
      if (!opts.input || !opts.output || !opts.toolkitRepository || opts.yes !== true) {
        io.err('improvement propose-toolkit-escalation requires --input, --toolkit-repository, --output, and explicit --yes');
        return EXIT_USAGE;
      }
      let input;
      let outputAbsolute;
      try {
        input = JSON.parse(readFileSync(resolveTargetPath(target, String(opts.input)), 'utf8'));
        outputAbsolute = resolveTargetPath(target, String(opts.output));
      } catch (error) {
        io.err(error.message);
        return 1;
      }
      void outputAbsolute;
      const built = buildToolkitEscalationProposal(target, input, opts.toolkitRepository);
      if (!built.ok) {
        for (const error of built.errors) io.err(error);
        return 1;
      }
      const validation = validateToolkitEscalationProposal(built.proposal);
      if (!validation.ok) {
        for (const error of validation.errors) io.err(error);
        return 1;
      }
      const written = executeMutationBatch(target, [{
        type: 'create', path: String(opts.output).replace(/\\/g, '/'),
        content: `${JSON.stringify(built.proposal, null, 2)}\n`,
      }]);
      if (!written.ok) {
        for (const error of [...written.errors, ...written.rollbackErrors]) io.err(error);
        return 1;
      }
      if (opts.json) io.out(JSON.stringify({
        disposition: 'proposal_exported', output: String(opts.output).replace(/\\/g, '/'),
        digest: built.proposal.digest, transferAuthority: built.proposal.transferAuthority,
      }, null, 2));
      else {
        io.out(`Exported sanitized toolkit proposal to ${opts.output}`);
        io.out('  Human review and an explicit import/recreation in the receiving toolkit repository are still required.');
      }
      return 0;
    }

    io.err(`Unknown improvement subcommand '${sub}'. Expected: new, lint, status, propose-toolkit-escalation.`);
    return EXIT_USAGE;
  } catch (error) {
    io.err(error.message);
    return 1;
  }
}
