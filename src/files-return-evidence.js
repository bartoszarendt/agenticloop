/** Reconstruct files-backed return evidence from current durable Git state. */

import { spawnSync } from 'node:child_process';
import { deriveCommitRange } from './commit-range.js';
import { isGitObjectId, sameGitObjectFormat } from './git-oid.js';
import { GIT_MAX_BUFFER } from './git-runner.js';
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
import { validateExecutionEvidence } from './execution-evidence.js';
import { parseFrontmatterStrict } from './frontmatter.js';
import { validateManifest } from './generated-artifacts.js';
import { validateHandoffRefreshReceipt } from './handoff-evidence-refresh.js';
import { VerificationContextMalformedError, VerificationContextStaleError } from './public-error.js';
import {
  createPathClassifier,
  resolveCarriedProductLineage,
} from './product-lineage.js';
import { pathIdentity } from './path-identity.js';
import { fileMatchesScopePattern } from './scope-matcher.js';

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
    // Return evidence asks for the execution terminal, which is the carrier the
    // signed return names - never the live carrier, which legitimately advances
    // once review, acceptance, and closeout own it.
    boundary: 'engineer_return',
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

/**
 * Classify a path that changed only in the carried region: history committed
 * before this attempt's packet was minted, under a previous attempt that was
 * then explicitly abandoned.
 *
 * The exact-record rule cannot apply there and should not: those records belong
 * to a generation that is over, and dispatch preparation already validated that
 * history at mint time through the clean gate and the decomposition binding.
 * What still holds is the boundary this whole classification exists to draw -
 * product work versus Agentic Loop's own state - and that scratch never becomes
 * either.
 *
 * Which state that is comes from the manifest that declares it, not from a list
 * of record locations maintained beside it. The list was already missing the
 * generator's own output manifest, the derived-evidence receipt added one
 * release earlier, and the project map - so carried history that the toolkit
 * itself wrote aborted the return as an unknown path. The declared state root
 * is the whole answer, and it stays correct as the toolkit grows new records.
 */
function classifyCarriedPath(path, classifier) {
  if (path === '.agenticloop/tmp' || path.startsWith(SCRATCH_PREFIX)) return 'scratch';
  const kind = classifier.classify(path);
  if (kind === 'product') return 'product';
  if (kind === 'toolkit_generated') return 'toolkit_generated';
  return 'workflow_evidence';
}

function classifyPath(path, { packet, workflow, runGit, workflowHead, classifier }) {
  if (path === '.agenticloop/tmp' || path.startsWith(SCRATCH_PREFIX)) return 'scratch';
  // Agentic Loop's own output is never the product's work and is never a
  // validated workflow record either. It is named for what it is, so a toolkit
  // update landing inside a return range neither poisons product lineage nor
  // aborts the return as an unknown path.
  if (classifier.classify(path) === 'toolkit_generated') return 'toolkit_generated';
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
  // Proof that a required check ran is written to a tracked path by default, so
  // committing it is the intended end state rather than an anomaly - and until
  // this family was recognized, committing it aborted the next evidence refetch
  // on the toolkit's own artifact. It is validated like every other record here,
  // and it must belong to the task the packet names.
  const execution = path.match(/^\.agenticloop\/checks\/([A-Za-z0-9._-]+)\/[A-Za-z0-9._-]+\.execution\.json$/);
  if (execution) {
    if (execution[1] !== packet?.task?.id) {
      throw new VerificationContextMalformedError(
        `workflow check evidence '${path}' belongs to a different task than the packet names`
      );
    }
    const text = readGit(runGit, ['show', `${workflowHead}:${path}`], `workflow check evidence '${path}'`);
    let record;
    try {
      record = JSON.parse(text);
    } catch {
      throw new VerificationContextMalformedError(`workflow check evidence '${path}' is not valid JSON`);
    }
    const checked = validateExecutionEvidence(record);
    if (!checked.ok) {
      throw new VerificationContextMalformedError(
        `workflow check evidence '${path}' is not a closed CLI execution artifact: ${checked.errors[0]}`
      );
    }
    return 'workflow_evidence';
  }
  // Target state the toolkit writes during an attempt that is not one of the
  // loop's records: the generator's own output manifest, the derived-evidence
  // receipt a refresh writes, and the project map. Running `agenticloop update`
  // or `task refresh-handoff-evidence` between minting a packet and producing
  // the return - both ordinary operator moves - used to abort the return on the
  // toolkit's own output. Each is recognized only after it validates, so none
  // is trusted for sitting at the right path.
  if (path === '.agenticloop/generated-artifacts.json') {
    const text = readGit(runGit, ['show', `${workflowHead}:${path}`], `workflow state '${path}'`);
    try {
      validateManifest(JSON.parse(text));
    } catch (error) {
      throw new VerificationContextMalformedError(
        `workflow state '${path}' is not a valid generated-artifacts manifest: ${error.message}`
      );
    }
    return 'workflow_evidence';
  }
  const derivedEvidence = path.match(/^\.agenticloop\/handoffs\/derived-evidence\/([A-Za-z0-9._-]+)\.json$/);
  if (derivedEvidence) {
    const text = readGit(runGit, ['show', `${workflowHead}:${path}`], `workflow derived evidence '${path}'`);
    let record;
    try {
      record = JSON.parse(text);
    } catch {
      throw new VerificationContextMalformedError(`workflow derived evidence '${path}' is not valid JSON`);
    }
    const checked = validateHandoffRefreshReceipt(record, { taskId: packet?.task?.id });
    if (!checked.ok || derivedEvidence[1] !== packet?.task?.id) {
      throw new VerificationContextMalformedError(
        `workflow derived evidence '${path}' is not this task's validated derived-evidence receipt: ` +
        `${checked.errors[0] ?? 'task identity mismatch'}`
      );
    }
    return 'workflow_evidence';
  }
  if (path === '.agenticloop/project.md') {
    const text = readGit(runGit, ['show', `${workflowHead}:${path}`], `workflow state '${path}'`);
    if (parseFrontmatterStrict(text).state === 'malformed') {
      throw new VerificationContextMalformedError(
        `workflow state '${path}' does not carry a readable project map`
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
  const runGit = args => spawnSync('git', args, { cwd: target, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
  const classifier = createPathClassifier(target);
  // The task's own declared surface. Where a task declares none, every path
  // stays in surface and the post-product rule below is the one it always was.
  const scopePatterns = (Array.isArray(packet?.task?.allowedPaths) ? packet.task.allowedPaths : [])
    .filter(pattern => typeof pattern === 'string' && pattern);
  const inTaskSurface = path => scopePatterns.length === 0 ||
    scopePatterns.some(pattern => fileMatchesScopePattern(path, pattern));
  const branch = readGit(runGit, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 'current return branch');
  const currentHead = readGit(runGit, ['rev-parse', '--verify', 'HEAD'], 'current return workflow head');
  const packetBaseHead = String(packet?.repository?.head ?? '').trim();
  // A resumed attempt whose product work was committed under a previous,
  // explicitly abandoned attempt binds that attempt's base as its own. The
  // claim is derived here from durable attempt records and re-derived
  // identically at the verification boundary, so it is checked rather than
  // asserted; without it the product range of every recovery is workflow-only
  // and no correct role behaviour can produce a return.
  const carried = resolveCarriedProductLineage(target, packet?.task?.id, {
    backend,
    packetBaseHead,
    runGit,
  });
  if (!carried.ok) {
    throw new VerificationContextMalformedError(
      `carried product lineage could not be resolved: ${carried.errors.join('; ')}`
    );
  }
  const productLineage = carried.lineage;
  const productBaseHead = productLineage ? productLineage.carriedBaseHead : packetBaseHead;
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
    allowedPaths: packet?.task?.allowedPaths,
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
  // Paths that changed only before this attempt's own base are carried
  // history, not this attempt's work, and are classified as such.
  const currentPaths = new Set(productLineage
    ? sortedPaths(readGit(
        runGit,
        ['diff', '--name-only', '--no-renames', `${packetBaseHead}..${workflowHead}`],
        'current-attempt changed-path inventory'
      ))
    : allPaths);
  const classified = new Map();
  for (const path of allPaths) {
    const category = currentPaths.has(path)
      ? classifyPath(path, { packet, workflow, runGit, workflowHead, classifier })
      : classifyCarriedPath(path, classifier);
    classified.set(path, category);
    if (category === 'scratch') {
      throw new VerificationContextMalformedError(`scratch path '${path}' cannot appear in return evidence`);
    }
    if (category === 'unknown') {
      throw new VerificationContextMalformedError(`unknown workflow path '${path}' cannot appear in return evidence`);
    }
  }
  // What "the declared productHead" claims is that this task's work ends there.
  // The claim is tested against the surface the task declares, because that is
  // the only surface it ever claimed anything about. A repository anyone else
  // also commits to keeps moving after the implementation lands - a lockfile
  // refresh, a config edit, a coworker's commit - and asking whether *anything*
  // changed after the product head made a finished implementation unreturnable
  // for as long as its repository stayed alive.
  //
  // A later change outside the task surface is therefore not a refusal; it is
  // simply not this return's product work, and it cannot be: it lands after the
  // head the return binds. It is recorded in the non-product half of the path
  // inventory, exactly as toolkit-generated output already is. A path the
  // engineer also changed inside the product range keeps its product
  // classification, so an out-of-scope edit still meets the scope-deviation
  // gate at verification.
  const productRangePaths = new Set(product.changedPaths);
  for (const path of laterPaths) {
    // A path can change after the product head and be restored to its base
    // content, which keeps it out of the range inventory above; classify it
    // here rather than letting it fall through unexamined.
    const category = classified.get(path) ?? (currentPaths.has(path)
      ? classifyPath(path, { packet, workflow, runGit, workflowHead, classifier })
      : classifyCarriedPath(path, classifier));
    if (category !== 'product') continue;
    if (inTaskSurface(path)) {
      throw new VerificationContextStaleError(
        `path '${path}' inside this task's allowed_paths changed after the declared productHead before workflowHead`
      );
    }
    if (!productRangePaths.has(path)) classified.set(path, 'outside_task_surface');
  }
  return {
    branch,
    productBaseHead,
    productLineage,
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
  // Repository evidence records only the baseline observation grammar. Execution
  // artifacts belong to the authenticated role return and are resolved at the
  // public CLI boundary, where the target filesystem is available.
  const checks = Array.isArray(signedEvidence?.checks)
    ? signedEvidence.checks.map(check => {
        if (!check || typeof check !== 'object' || Array.isArray(check)) return check;
        const { executionEvidence: _executionEvidence, ...observation } = check;
        return observation;
      })
    : signedEvidence?.checks;
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
    worktree: pathIdentity(target).authorityPath,
    branch: derived.branch,
    productBaseHead: derived.productBaseHead,
    productLineage: derived.productLineage,
    productHead: derived.productHead,
    workflowHead: derived.workflowHead,
    candidateHead: null,
    productChangedPaths: derived.productChangedPaths,
    workflowChangedPaths: derived.workflowChangedPaths,
    productAttribution: derived.productAttribution,
    // Keep the stable check observation fields in their authenticated canonical
    // order, without copying role-return execution artifact references.
    checks,
    carrierLineage: derived.carrierLineage,
    pr: { state: 'not_applicable', number: null, url: null },
  };
}
