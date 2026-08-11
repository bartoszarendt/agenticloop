/** Reconstruct files-backed return evidence from current durable Git state. */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { deriveCommitRange } from './commit-range.js';
import { isGitObjectId, sameGitObjectFormat } from './git-oid.js';
import {
  carrierMutationRelativePath,
  dispatchConsumptionRelativePath,
  resolveCarrierLineage,
  validateDispatchConsumption,
} from './handoff-consumption.js';
import {
  validateCarrierMutationReceipt,
} from './task-evidence-contract.js';
import { validateAuditRecord } from './audit-record.js';
import { VerificationContextMalformedError, VerificationContextStaleError } from './public-error.js';

const SCRATCH_PREFIX = '.agenticloop/tmp/';

function sortedPaths(value) {
  return [...new Set(String(value ?? '').split(/\r?\n/).filter(Boolean))].sort();
}

function readGit(runGit, args, label) {
  const result = runGit(args);
  if (result.status !== 0) {
    throw new VerificationContextStaleError(`${label} is unavailable: ${String(result.stderr ?? '').trim()}`);
  }
  return String(result.stdout ?? '').trim();
}

function requireAncestor(runGit, ancestor, descendant, label) {
  const result = runGit(['merge-base', '--is-ancestor', ancestor, descendant]);
  if (result.status !== 0) {
    throw new VerificationContextStaleError(`${label} is not an ancestor of ${descendant}`);
  }
}

function exactWorkflowPaths(target, packet, signedEvidence, runGit, workflowHead, { historicalCloseout }) {
  // A historical closeout still has to prove that each workflow path belongs
  // to the same active carrier generation; ancestry alone cannot authorize an
  // arbitrary .agenticloop record in the retained workflow range.
  const lineage = resolveCarrierLineage(target, packet?.task?.id, {
    backend: 'files',
    taskContractDigest: packet?.task?.taskContractDigest,
    currentCarrierDigest: signedEvidence?.task?.currentCarrierDigest,
  });
  if (!lineage.ok) {
    throw new VerificationContextMalformedError(
      `current files carrier lineage is invalid: ${lineage.errors.join('; ')}`
    );
  }
  const records = new Map();
  records.set(dispatchConsumptionRelativePath(lineage.dispatchConsumption), {
    kind: 'dispatch', record: lineage.dispatchConsumption,
  });
  for (const receipt of lineage.receipts) {
    records.set(carrierMutationRelativePath(receipt), { kind: 'mutation', record: receipt });
  }
  return { lineage, records };
}

function workflowRecordAtHead(runGit, workflowHead, path, expected) {
  let text;
  try {
    text = readGit(runGit, ['show', `${workflowHead}:${path}`], `workflow evidence '${path}'`);
  } catch (error) {
    throw new VerificationContextMalformedError(error.message);
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    throw new VerificationContextMalformedError(`workflow evidence '${path}' is not valid JSON`);
  }
  const checked = expected.kind === 'dispatch'
    ? validateDispatchConsumption(record, {
        backend: expected.record.backend,
        taskId: expected.record.taskId,
        filename: path.split('/').at(-1),
      })
    : validateCarrierMutationReceipt(record);
  if (!checked.ok || record.digest !== expected.record.digest) {
    throw new VerificationContextMalformedError(
      `workflow evidence '${path}' is not the exact validated active ${expected.kind} record`
    );
  }
}

function classifyPath(path, { packet, workflow, runGit, workflowHead }) {
  if (path === '.agenticloop/tmp' || path.startsWith(SCRATCH_PREFIX)) return 'scratch';
  if (path === packet?.task?.carrier) {
    return workflow?.lineage ? 'task_carrier' : 'unknown';
  }
  const expected = workflow?.records.get(path);
  if (expected) {
    workflowRecordAtHead(runGit, workflowHead, path, expected);
    return 'workflow_evidence';
  }
  if (/^\.agenticloop\/audits\/[A-Za-z0-9._-]+\.md$/.test(path)) {
    const text = readGit(runGit, ['show', `${workflowHead}:${path}`], `workflow audit '${path}'`);
    const errors = validateAuditRecord(text, path);
    if (errors.length > 0) {
      throw new VerificationContextMalformedError(
        `workflow audit '${path}' is not a validated canonical audit record: ${errors[0]}`
      );
    }
    return 'workflow_evidence';
  }
  // Return evidence does not trust an entire metadata directory. A record that
  // is not an exact active dispatch or Engineer evidence receipt is unknown.
  if (path.startsWith('.agenticloop/')) return 'unknown';
  return 'product';
}

/**
 * Re-derive the three-head topology and every return path from Git. This is the
 * shared source used by files evidence and any GitHub route with a local trusted
 * checkout; callers never supply a changed-path classification.
 */
export function deriveReturnTopology(target, packet, signedEvidence, {
  historicalCloseout = false,
  backend = 'files',
} = {}) {
  const runGit = args => spawnSync('git', args, { cwd: target, encoding: 'utf8' });
  const branch = readGit(runGit, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 'current return branch');
  const currentHead = readGit(runGit, ['rev-parse', '--verify', 'HEAD'], 'current return workflow head');
  const productBaseHead = String(packet?.repository?.head ?? '').trim();
  const productHead = String(signedEvidence?.productHead ?? '').trim();
  const workflowHead = historicalCloseout
    ? String(signedEvidence?.workflowHead ?? '').trim()
    : currentHead;
  const identities = [productBaseHead, productHead, workflowHead];
  if (!identities.every(isGitObjectId) || !sameGitObjectFormat(identities)) {
    throw new VerificationContextMalformedError(
      'current return productBaseHead, productHead, and workflowHead must be full identities of one Git object format'
    );
  }
  if (historicalCloseout) {
    requireAncestor(runGit, workflowHead, currentHead, 'historical return workflowHead');
  } else {
    for (const args of [['diff', '--quiet'], ['diff', '--cached', '--quiet']]) {
      if (runGit(args).status !== 0) {
        throw new VerificationContextStaleError('tracked repository state changed after the role-return evidence was collected');
      }
    }
  }
  requireAncestor(runGit, productBaseHead, productHead, 'productBaseHead');
  requireAncestor(runGit, productHead, workflowHead, 'productHead');

  const product = deriveCommitRange({
    runGit,
    baseHead: productBaseHead,
    head: productHead,
    taskId: packet?.task?.id,
    roleId: packet?.assignment?.roleId,
  });
  if (!product.ok) {
    throw product.evidenceState === 'malformed'
      ? new VerificationContextMalformedError(product.message)
      : new VerificationContextStaleError(product.message);
  }
  const workflow = exactWorkflowPaths(target, packet, signedEvidence, runGit, workflowHead, { historicalCloseout });
  const allPaths = sortedPaths(readGit(
    runGit,
    ['diff', '--name-only', '--no-renames', `${productBaseHead}..${workflowHead}`],
    'return changed-path inventory'
  ));
  const laterPaths = sortedPaths(readGit(
    runGit,
    ['diff', '--name-only', '--no-renames', `${productHead}..${workflowHead}`],
    'post-product changed-path inventory'
  ));
  const classified = new Map();
  for (const path of allPaths) {
    const category = classifyPath(path, { packet, workflow, runGit, workflowHead });
    classified.set(path, category);
    if (category === 'scratch') {
      throw new VerificationContextMalformedError(`scratch path '${path}' cannot appear in return evidence`);
    }
    if (category === 'unknown') {
      throw new VerificationContextMalformedError(`unknown workflow path '${path}' cannot appear in return evidence`);
    }
  }
  for (const path of laterPaths) {
    if (classifyPath(path, { packet, workflow, runGit, workflowHead }) === 'product') {
      throw new VerificationContextStaleError(
        `product path '${path}' changed after the declared productHead before workflowHead`
      );
    }
  }
  return {
    branch,
    productBaseHead,
    productHead,
    workflowHead,
    productChangedPaths: allPaths.filter(path => classified.get(path) === 'product'),
    workflowChangedPaths: allPaths.filter(path => classified.get(path) !== 'product'),
    productAttribution: { range: product.range, commits: product.commits },
    carrierLineage: workflow
      ? {
          dispatchConsumptionDigest: workflow.lineage.dispatchConsumption.digest,
          evidenceMutationReceiptDigests: workflow.lineage.receipts.map(receipt => receipt.digest),
        }
      : signedEvidence?.carrierLineage,
  };
}

export function refetchFilesReturnEvidence(target, packet, signedEvidence, options = {}) {
  const derived = deriveReturnTopology(target, packet, signedEvidence, options);
  return {
    backend: 'files',
    task: {
      id: packet?.task?.id,
      taskContractDigest: packet?.task?.taskContractDigest,
      dispatchCarrierDigest: packet?.task?.dispatchCarrierDigest,
      currentCarrierDigest: derived.carrierLineage
        ? signedEvidence?.task?.currentCarrierDigest
        : signedEvidence?.task?.currentCarrierDigest,
    },
    worktree: resolve(target),
    branch: derived.branch,
    productBaseHead: derived.productBaseHead,
    productHead: derived.productHead,
    workflowHead: derived.workflowHead,
    candidateHead: null,
    productChangedPaths: derived.productChangedPaths,
    workflowChangedPaths: derived.workflowChangedPaths,
    productAttribution: derived.productAttribution,
    // Required-check observations are role-return evidence, not a local Git
    // fact. The receiving boundary validates their closed inventory separately.
    checks: signedEvidence?.checks,
    carrierLineage: derived.carrierLineage,
    pr: { state: 'not_applicable', number: null, url: null },
  };
}
