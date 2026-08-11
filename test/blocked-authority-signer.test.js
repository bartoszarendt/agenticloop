import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  validateBlockedResultRedelegation,
} from '../src/blocked-result-authority.js';
import { createRoleReturn } from '../src/dispatch-envelope.js';
import { generateHostSigningKey } from '../src/host-trust.js';

const FULL_SHA_A = '1111111111111111111111111111111111111111';
const FULL_SHA_B = '2222222222222222222222222222222222222222';
const SIGNER_PATH = fileURLToPath(new URL('../scripts/sign-blocked-authority.mjs', import.meta.url));
let temp;

before(() => {
  temp = mkdtempSync(join(tmpdir(), 'agenticloop-authority-signer-'));
});

after(() => {
  rmSync(temp, { recursive: true, force: true });
});

function blockedReturn() {
  return createRoleReturn({
    producerRole: 'engineer',
    packet: {
      packetId: 'dispatch:11111111-1111-4111-8111-111111111111',
      digest: `sha256:agenticloop.role-preparation.v4:${'1'.repeat(64)}`,
    },
    task: {
      backend: 'files',
      id: 'T-001',
      taskContractDigest: `sha256:v1:${'2'.repeat(64)}`,
      dispatchCarrierDigest: `sha256:${'3'.repeat(64)}`,
      currentCarrierDigest: `sha256:${'3'.repeat(64)}`,
    },
    worktree: 'C:\\target',
    branch: 'task/T-001',
    productBaseHead: FULL_SHA_A,
    productHead: FULL_SHA_B,
    workflowHead: FULL_SHA_B,
    candidateHead: null,
    productChangedPaths: [],
    workflowChangedPaths: [],
    checks: [{
      id: 'RC-1',
      kind: 'command',
      command: 'npm test',
      outcome: 'blocked',
      exitCode: 1,
      evidence: 'host state prevents execution',
    }],
    productAttribution: {
      range: { base: FULL_SHA_A, head: FULL_SHA_B },
      commits: [FULL_SHA_B],
    },
    carrierLineage: {
      dispatchConsumptionDigest: `sha256:agenticloop.dispatch-consumption.v3:${'4'.repeat(64)}`,
      evidenceMutationReceiptDigests: [],
    },
    pr: { state: 'not_applicable', number: null, url: null },
    outcome: {
      kind: 'implementation_blocked',
      completion: false,
      authority: 'non_authoritative_role_outcome',
    },
    disposition: 'blocked',
    blocker: {
      category: 'host_state',
      evidence: { kind: 'command_failure', detail: 'sandbox mount is read-only' },
      resumeOwner: 'engineer',
      resumeTransition: 'implementation_resume',
      resumePreconditions: {
        items: ['Restore the task worktree write mount.'],
        justification: null,
      },
    },
    freshness: {
      invalidatedBy: [
        'task_or_contract_changes',
        'packet_or_assignment_changes',
        'branch_or_head_changes',
        'check_or_transport_evidence_changes',
        'initial_repository_state_changes',
      ],
    },
  });
}

describe('canonical blocked-authority signing helper', () => {
  it('constructs and signs a verifiable record without echoing private key material', () => {
    const returned = blockedReturn();
    const key = generateHostSigningKey();
    const authorityId = 'agenticloop.test.orchestrator';
    const keyId = 'orchestrator-authority-1';
    const privateKeyPem = key.privateKey.export({ format: 'pem', type: 'pkcs8' });
    const requestPath = join(temp, 'request.json');
    const keyPath = join(temp, 'authority-key.pem');
    const outputPath = join(temp, 'redelegation.json');
    writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });
    writeFileSync(requestPath, `${JSON.stringify({
      type: 'blocked_result_redelegation',
      signing: { authorityId, keyId },
      record: {
        blockedReturn: returned,
        toRole: 'maintainer',
        authority: {
          ownerKind: 'workflow_role',
          ownerId: 'orchestrator',
          reference: 'dispatch:redelegate:T-001',
        },
        reason: 'Maintainer must repair the task contract.',
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    }, null, 2)}\n`, 'utf8');

    const result = spawnSync(process.execPath, [
      SIGNER_PATH,
      '--request', requestPath,
      '--private-key', keyPath,
      '--output', outputPath,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), outputPath);
    assert.doesNotMatch(result.stdout, /PRIVATE KEY/);

    const recordText = readFileSync(outputPath, 'utf8');
    assert.doesNotMatch(recordText, /PRIVATE KEY/);
    const record = JSON.parse(recordText);
    const checked = validateBlockedResultRedelegation(record, {
      blockedReturn: returned,
      resolveTrustedAuthority: () => ({
        authorityId,
        authorityKind: 'blocked_result_redelegation',
        keyId,
        algorithm: 'ed25519',
        publicKey: key.publicKeyBase64,
        issuer: { ownerKind: 'workflow_role', ownerId: 'orchestrator' },
        revokedRecordIds: [],
      }),
    });
    assert.equal(checked.ok, true, checked.errors.join('\n'));

    const repeated = spawnSync(process.execPath, [
      SIGNER_PATH,
      '--request', requestPath,
      '--private-key', keyPath,
      '--output', outputPath,
    ], { encoding: 'utf8' });
    assert.equal(repeated.status, 2);
    assert.match(repeated.stderr, /EEXIST|file already exists/i);
  });
});
