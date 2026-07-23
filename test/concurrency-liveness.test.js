/**
 * Tests for the Phase U concurrency + subagent-liveness guardrails.
 *
 * Covers:
 *   - generated adapter role surfaces carry the serial-default / concurrency-plan
 *     / lease wording (orchestrator) and the lease + status-return obligation
 *     (maintainer, engineer) for every implemented host;
 *   - the engineer surface guards branch/worktree before continuing;
 *   - the GitHub merge-barrier wording stays consistent across the three
 *     canonical docs that repeat it;
 *   - the durable `## Concurrency Plan` task-record section stays registered;
 *   - the migrated lease terminology does not regress to "progress interval";
 *   - self-loop and observable-step lease hardening stays present in canonical
 *     docs and generated worker surfaces.
 *
 * This is the mechanical guard tracked as Phase U / U-07: the concurrency and
 * liveness contract lives in several places at once, so a snapshot-style check
 * keeps them from silently drifting apart.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { generateOpencodeArtifacts } from '../src/adapters/opencode.js';
import { generateCodexArtifacts } from '../src/adapters/codex.js';
import { generateClaudeCodeArtifacts } from '../src/adapters/claude-code.js';
import { generateCopilotArtifacts } from '../src/adapters/copilot.js';
import { generateCursorArtifacts } from '../src/adapters/cursor.js';
import { TASK_OPTIONAL_SECTION_HEADINGS } from '../src/layout.js';
import { loadAgenticLoopConfig } from '../src/json.js';
import { seedTargetLayout } from './helpers/layout-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

// Each host generates a role surface for the three logical roles. The path
// shapes match the per-adapter tests, which already pin these as the contract.
const HOSTS = [
  { name: 'opencode', generate: generateOpencodeArtifacts, agentPath: role => `.opencode/agents/${role}.md` },
  { name: 'codex', generate: generateCodexArtifacts, agentPath: role => `.codex/agents/${role}.toml` },
  { name: 'claude-code', generate: generateClaudeCodeArtifacts, agentPath: role => `.claude/agents/${role}.md` },
  { name: 'copilot', generate: generateCopilotArtifacts, agentPath: role => `.github/agents/${role}.agent.md` },
  { name: 'cursor', generate: generateCursorArtifacts, agentPath: role => `.cursor/agents/${role}.md` },
];

const ROLES = ['orchestrator', 'maintainer', 'engineer'];

let tmpDir;
// key: `${host}:${role}` -> generated surface text
const surfaces = new Map();

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'al-concurrency-'));
  const fx = mkdtempSync(join(tmpDir, 'fx-'));
  seedTargetLayout(REPO_ROOT, fx, { includeDocs: false, includeScratch: false });

  const cfg = loadAgenticLoopConfig(join(fx, 'agenticloop.json'));
  // The shared fixture config only seeds role settings for some hosts; Copilot
  // needs explicit models like its own adapter test supplies.
  cfg.adapters.copilot.roleSettings = {
    orchestrator: { model: 'gpt-5.4' },
    maintainer: { model: 'gpt-5.5' },
    engineer: { model: 'gpt-5.4-mini' },
  };

  for (const host of HOSTS) {
    const out = mkdtempSync(join(tmpDir, `out-${host.name}-`));
    const { files } = host.generate(cfg, fx, out);
    for (const role of ROLES) {
      const rel = host.agentPath(role);
      assert.ok(files.includes(rel), `${host.name} did not generate ${rel}`);
      surfaces.set(`${host.name}:${role}`, readFileSync(join(out, rel), 'utf-8'));
    }
  }
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('generated orchestrator surfaces default to serial with a concurrency plan and lease', () => {
  for (const host of HOSTS) {
    it(`${host.name} orchestrator states serial default, concurrency plan, and lease`, () => {
      const text = surfaces.get(`${host.name}:orchestrator`);
      assert.match(text, /serial(ly)? by default/i, `${host.name} orchestrator missing serial-default wording`);
      assert.match(text, /concurrency plan/i, `${host.name} orchestrator missing concurrency-plan wording`);
      assert.match(text, /lease/i, `${host.name} orchestrator missing lease wording`);
    });
  }
});

describe('generated orchestrator surfaces route parallel decisions through the conditional skill', () => {
  for (const host of HOSTS) {
    it(`${host.name} orchestrator mentions parallel-delegation`, () => {
      const text = surfaces.get(`${host.name}:orchestrator`);
      assert.match(text, /parallel-delegation/i, `${host.name} orchestrator missing parallel-delegation wording`);
    });

    it(`${host.name} orchestrator keeps concrete serial-reason wording`, () => {
      const text = surfaces.get(`${host.name}:orchestrator`);
      assert.match(text, /concrete serial reason/i, `${host.name} orchestrator missing concrete serial reason wording`);
    });
  }
});

describe('generated orchestrator surfaces preserve mandatory scan wording', () => {
  for (const host of HOSTS) {
    it(`${host.name} orchestrator requires a current scan reference or rescan trigger`, () => {
      const text = surfaces.get(`${host.name}:orchestrator`);
      assert.match(text, /Parallel Opportunity Scan after decomposition/i);
      assert.match(text, /not-currently-eligible status/i);
      assert.match(text, /rescan trigger/i);
    });
  }
});

describe('canonical Parallel Opportunity Scan policy is documented', () => {
  it('parallel-delegation states the serial justification requirement', () => {
    const text = readFileSync(join(REPO_ROOT, 'skills', 'parallel-delegation', 'SKILL.md'), 'utf-8').replace(/\s+/g, ' ');
    assert.match(text, /only with a concrete recorded reason/i);
    assert.match(text, /sufficient serial reason/i);
    assert.match(text, /max_parallel_implementation_lanes.*default\s+`?5`?/i);
  });

  it('parallel-delegation documents unknown -> read-only discovery -> decide', () => {
    const text = readFileSync(join(REPO_ROOT, 'skills', 'parallel-delegation', 'SKILL.md'), 'utf-8').replace(/\s+/g, ' ');
    assert.match(text, /Unknown collision criteria must not start write lanes/i);
    assert.match(text, /bounded read-only discovery step first/i);
    assert.match(text, /After discovery, decide/i);
    assert.match(text, /If uncertainty remains after bounded discovery, run serial/i);
  });

  it('parallel-delegation preserves the short bounded batch observability split', () => {
    const text = readFileSync(join(REPO_ROOT, 'skills', 'parallel-delegation', 'SKILL.md'), 'utf-8').replace(/\s+/g, ' ');
    assert.match(text, /do not start long-running parallel delegation/i);
    assert.match(text, /Short bounded parallel batches/i);
    assert.match(text, /If host limitations make even bounded join-based parallelism unverifiable/i);
    assert.match(text, /run serial and record the host limitation as the concrete reason/i);
  });

  it('requires a current scan, independent proposal reassessment, and implementation-only ceiling', () => {
    const text = readFileSync(join(REPO_ROOT, 'skills', 'parallel-delegation', 'SKILL.md'), 'utf-8').replace(/\s+/g, ' ');
    assert.match(text, /Every authorized multi-task work unit.*current scan/i);
    assert.match(text, /fewer than two ready tasks.*not currently eligible/i);
    assert.match(text, /Source plans.*inputs only/i);
    assert.match(text, /accepts, narrows, reorders, or rejects/i);
    assert.match(text, /ceiling, never a target or total-live-agent budget/i);
    assert.match(text, /Review, coordination, and integration lanes do not inherit/i);
  });

  it('requires every multi-task implementation delegation to carry the scan reference', () => {
    const text = readFileSync(join(REPO_ROOT, 'skills', 'role-delegation', 'SKILL.md'), 'utf-8').replace(/\s+/g, ' ');
    assert.match(text, /Parallel scan:\s+`completed - <durable reference>`/i);
    assert.match(text, /not currently eligible - <reason and rescan trigger>/i);
    assert.match(text, /Do not delegate multi-task implementation work with the field missing/i);
  });
});

describe('Parallel Safety task-record section is documented', () => {
  it('the canonical task-record template contains the Parallel Safety section', () => {
    const text = readFileSync(join(REPO_ROOT, 'memory', 'task-record.md'), 'utf-8');
    assert.match(text, /## Parallel Safety/);
    assert.match(text, /Parallel eligibility: eligible \| blocked \| unknown/);
  });

  it('the task-record-contract skill documents Parallel Safety', () => {
    const text = readFileSync(join(REPO_ROOT, 'skills', 'task-record-contract', 'SKILL.md'), 'utf-8');
    assert.match(text, /## Parallel Safety/);
  });

  it('layout registers "## Parallel Safety" as an optional task section', () => {
    assert.ok(
      TASK_OPTIONAL_SECTION_HEADINGS.includes('## Parallel Safety'),
      'TASK_OPTIONAL_SECTION_HEADINGS must include "## Parallel Safety"'
    );
  });
});

describe('generated worker surfaces honor leases and return status', () => {
  for (const host of HOSTS) {
    for (const role of ['maintainer', 'engineer']) {
      it(`${host.name} ${role} honors the lease and returns status`, () => {
        const text = surfaces.get(`${host.name}:${role}`);
        assert.match(text, /lease/i, `${host.name} ${role} missing lease obligation`);
        assert.match(text, /status/i, `${host.name} ${role} missing status-return obligation`);
        assert.match(text, /no-progress|stop condition/i, `${host.name} ${role} missing stop/no-progress wording`);
      });
    }
  }
});

describe('self-loop guard is preserved across worker surfaces', () => {
  for (const host of HOSTS) {
    for (const role of ['maintainer', 'engineer']) {
      it(`${host.name} ${role} carries the self-loop no-progress guard`, () => {
        const text = surfaces.get(`${host.name}:${role}`);
        assert.match(text, /same intended next action twice/i, `${host.name} ${role} missing repeated-intent guard`);
        assert.match(text, /blocked-state category(?:\\n|\s)+`no-progress`/i, `${host.name} ${role} missing no-progress escalation`);
        assert.match(text, /Do not re-verify an artifact you just produced/i, `${host.name} ${role} missing re-verify guard`);
      });
    }
  }
});

describe('canonical no-progress guard is documented', () => {
  it('AGENTIC_LOOP.md defines repeated-intent attempts, status progress, and act-over-reverify', () => {
    const text = readFileSync(join(REPO_ROOT, 'AGENTIC_LOOP.md'), 'utf-8').replace(/\s+/g, ' ');
    assert.match(text, /restated intended next action/i);
    assert.match(text, /same intended next action twice/i);
    assert.match(text, /`blocked`, `needs_context`, or `complete` status return is progress/i);
    assert.match(text, /do not re-decide or re-verify it unless new contradictory evidence appears/i);
  });

  it('blocked-state defines no-progress as a durable block category', () => {
    const text = readFileSync(join(REPO_ROOT, 'skills', 'blocked-state', 'SKILL.md'), 'utf-8').replace(/\s+/g, ' ');
    assert.match(text, /exhausted attempt budget \/ self-loop with no progress/i);
    assert.match(text, /\| `no-progress` \| The attempt budget or self-loop guard tripped/i);
  });
});

describe('generated engineer surfaces guard branch/worktree before continuing', () => {
  for (const host of HOSTS) {
    it(`${host.name} engineer returns on a wrong branch or worktree`, () => {
      const text = surfaces.get(`${host.name}:engineer`);
      assert.match(text, /branch|worktree/i, `${host.name} engineer missing branch/worktree guard`);
    });
  }
});

describe('GitHub merge-barrier wording is consistent across canonical docs', () => {
  const DOCS = [
    'skills/parallel-delegation/SKILL.md',
    'backends/github.md',
  ];
  // Invariants every merge-barrier statement must keep, regardless of phrasing.
  const REQUIRED = [
    /every (parallel )?lane has returned/i,
    /maintainer review is complete/i,
    /cross-branch/i,
    /approves (the )?merge order/i,
  ];

  for (const doc of DOCS) {
    it(`${doc} states every merge-barrier invariant`, () => {
      // Collapse whitespace so hard-wrapped prose still matches single-line patterns.
      const text = readFileSync(join(REPO_ROOT, doc), 'utf-8').replace(/\s+/g, ' ');
      for (const pattern of REQUIRED) {
        assert.match(text, pattern, `${doc} missing merge-barrier invariant ${pattern}`);
      }
    });
  }
});

describe('durable concurrency-plan section stays registered', () => {
  it('layout registers "## Concurrency Plan" as an optional task section', () => {
    assert.ok(
      TASK_OPTIONAL_SECTION_HEADINGS.includes('## Concurrency Plan'),
      'TASK_OPTIONAL_SECTION_HEADINGS must include "## Concurrency Plan"'
    );
  });

  it('the canonical task-record template contains the Concurrency Plan section', () => {
    const text = readFileSync(join(REPO_ROOT, 'memory', 'task-record.md'), 'utf-8');
    assert.match(text, /## Concurrency Plan/);
  });

  it('the task-record-contract skill documents the Concurrency Plan section', () => {
    const text = readFileSync(join(REPO_ROOT, 'skills', 'task-record-contract', 'SKILL.md'), 'utf-8');
    assert.match(text, /Concurrency Plan/);
  });
});

describe('lease terminology does not regress', () => {
  it('parallel-delegation uses "progress checkpoint cadence", not "progress interval"', () => {
    const text = readFileSync(join(REPO_ROOT, 'skills', 'parallel-delegation', 'SKILL.md'), 'utf-8');
    assert.match(text, /progress checkpoint cadence/i);
    assert.doesNotMatch(text, /progress interval/i);
  });

  it('canonical delegation docs require observable-step checkpoint cadence', () => {
    const docs = [
      'agents/orchestrator.md',
      'skills/role-delegation/SKILL.md',
      'skills/parallel-delegation/SKILL.md',
      'commands/start.md',
    ];
    for (const doc of docs) {
      const text = readFileSync(join(REPO_ROOT, doc), 'utf-8');
      assert.match(text, /observable-step checkpoint cadence/i, `${doc} missing observable-step lease wording`);
    }

    const processDoc = readFileSync(join(REPO_ROOT, 'skills', 'parallel-delegation', 'SKILL.md'), 'utf-8').replace(/\s+/g, ' ');
    assert.match(processDoc, /private reasoning is not a step/i);

    const delegationSkill = readFileSync(join(REPO_ROOT, 'skills', 'role-delegation', 'SKILL.md'), 'utf-8');
    assert.match(delegationSkill, /return-after-N-observable-steps/i);
  });

  it('generated orchestrator surfaces carry observable-step lease wording', () => {
    for (const host of HOSTS) {
      const text = surfaces.get(`${host.name}:orchestrator`);
      assert.match(text, /observable-step checkpoint cadence/i, `${host.name} orchestrator missing observable-step lease wording`);
    }
  });

  it('host-adapter docs state runtime loop-guard capabilities', () => {
    const text = readFileSync(join(REPO_ROOT, 'docs', 'host-adapters.md'), 'utf-8').replace(/\s+/g, ' ');
    assert.match(text, /Loop-Guard Capabilities/);
    assert.match(text, /surface running role status/i);
    assert.match(text, /cancel a runaway role/i);
    assert.match(text, /max steps, max tokens, or timeout limits/i);
    assert.match(text, /bounded serial delegation/i);
  });
});

/**
 * Knowledge-coordination and combined-verification half of the parallel
 * delegation contract: mutation vs knowledge independence, cross-lane finding
 * routing and dispositions, verification topology, and the non-publishing
 * integration rehearsal. Snapshot-style guards that keep the canonical
 * surfaces from silently drifting apart.
 */

const CANONICAL = {
  loop: 'AGENTIC_LOOP.md',
  parallel: 'skills/parallel-delegation/SKILL.md',
  taskRecord: 'memory/task-record.md',
  taskContract: 'skills/task-record-contract/SKILL.md',
  roleDelegation: 'skills/role-delegation/SKILL.md',
  verification: 'skills/verification-evidence/SKILL.md',
  orchestrator: 'agents/orchestrator.md',
  maintainer: 'agents/maintainer.md',
  engineer: 'agents/engineer.md',
  filesBackend: 'backends/files.md',
  githubBackend: 'backends/github.md',
};

function canonicalText(rel) {
  return readFileSync(join(REPO_ROOT, rel), 'utf-8').replace(/\s+/g, ' ');
}

describe('mutation and knowledge independence are separate eligibility dimensions', () => {
  it('core methodology distinguishes mutation independence from knowledge independence', () => {
    const text = canonicalText(CANONICAL.loop);
    assert.match(text, /Mutation independence and knowledge independence/i);
    assert.match(text, /Parallel write execution requires both/i);
    assert.match(text, /independent`, `coupled`, or `unknown`/i);
    assert.match(text, /Separate worktrees isolate mutation; they never convert coupled or unknown tasks into independent tasks/i);
  });

  it('parallel-delegation classifies knowledge coupling and the two-wave pattern', () => {
    const text = canonicalText(CANONICAL.parallel);
    assert.match(text, /## Knowledge Eligibility/);
    assert.match(text, /`independent`, `coupled`, or `unknown`/i);
    assert.match(text, /bounded parallel read-only diagnosis/i);
    assert.match(text, /Reconciliation at the join/i);
    assert.match(text, /newly justified parallel implementation plan/i);
    assert.match(text, /never convert coupled or unknown tasks into independent tasks/i);
  });

  it('task-record template carries the knowledge-coupling classification', () => {
    const text = canonicalText(CANONICAL.taskRecord);
    assert.match(text, /Knowledge coupling: independent \| coupled \| unknown/);
    assert.match(text, /Shared assumptions\/invariants:/);
    assert.match(text, /Discoveries that could affect other tasks:/);
    assert.match(text, /Parallel write execution requires `eligible` plus `independent`/i);
  });

  it('task-record-contract mirrors the knowledge-coupling classification', () => {
    const text = canonicalText(CANONICAL.taskContract);
    assert.match(text, /Knowledge coupling.*`independent`, `coupled`, or `unknown`/i);
    assert.match(text, /Shared assumptions\/invariants/);
    assert.match(text, /Discoveries that could affect other tasks/);
  });
});

describe('shared design authority is explicit in parallel planning', () => {
  it('records decision scope and resolves shared design questions before parallel writes', () => {
    const parallel = canonicalText(CANONICAL.parallel);
    const taskRecord = canonicalText(CANONICAL.taskRecord);
    assert.match(parallel, /Decision scope:/);
    assert.match(parallel, /Shared design questions:/);
    assert.match(parallel, /resolved by the maintainer or a serial reconciliation step before parallel implementation writes/i);
    assert.match(parallel, /Disjoint files do not imply independent design authority/i);
    assert.match(taskRecord, /Decision scope:/);
    assert.match(taskRecord, /Shared design questions:/);
  });
});

describe('cross-lane findings are routed and disposed without a ledger', () => {
  it('parallel-delegation defines the finding shape and the explicit none return', () => {
    const text = canonicalText(CANONICAL.parallel);
    assert.match(text, /Cross-lane findings: none/);
    assert.match(text, /Finding id/);
    assert.match(text, /Fact or invariant/);
    assert.match(text, /Evidence reference/);
    assert.match(text, /Affected lane ids, or `none`/);
    assert.match(text, /Requested response.*`apply`.*`revalidate`/i);
  });

  it('parallel-delegation requires recipient dispositions and a blocked join', () => {
    const text = canonicalText(CANONICAL.parallel);
    assert.match(text, /`applied`/);
    assert.match(text, /`already satisfied`/);
    assert.match(text, /`rejected` with evidence/);
    assert.match(text, /`deferred` with a reason/);
    assert.match(text, /join incomplete while any routed finding lacks a disposition/i);
    assert.match(text, /join is also incomplete while a routed finding lacks a disposition/i);
    assert.match(text, /A disposition records handling; it does not by itself make the finding non-blocking/i);
    assert.match(text, /`deferred` completes the join only after maintainer\/orchestrator triage/i);
    assert.match(text, /Otherwise the finding blocks the join/i);
  });

  it('parallel-delegation forbids a findings ledger and is honest about host limits', () => {
    const text = canonicalText(CANONICAL.parallel);
    assert.match(text, /Do not create a findings ledger or a shared mutable findings file/i);
    assert.match(text, /single-writer durable surface/i);
    assert.match(text, /cannot inject a message into a running agent, do not pretend otherwise/i);
  });

  it('role-delegation carries a separate Routed findings field', () => {
    const text = canonicalText(CANONICAL.roleDelegation);
    assert.match(text, /Routed findings:\s+none \| <finding ids/i);
    assert.match(text, /Do not overload `Operating facts` with raw findings/i);
    assert.match(text, /never claim asynchronous delivery the host cannot perform/i);
  });

  it('orchestrator routes findings and keeps the join incomplete', () => {
    const text = canonicalText(CANONICAL.orchestrator);
    assert.match(text, /Collect cross-lane findings/i);
    assert.match(text, /require a recorded disposition/i);
    assert.match(text, /join incomplete while any routed finding lacks a disposition/i);
    assert.match(text, /deferred finding remains blocking until maintainer\/orchestrator triage/i);
    assert.match(text, /do not concurrently edit a task file owned by an active write lane/i);
  });

  it('engineer declares findings and returns dispositions', () => {
    const text = canonicalText(CANONICAL.engineer);
    assert.match(text, /Cross-lane findings: none/);
    assert.match(text, /exactly one disposition per finding/i);
    assert.match(text, /could invalidate another active lane's assumptions/i);
  });
});

describe('verification topology and evidence identity are documented', () => {
  const TOPOLOGY_DOCS = ['parallel', 'verification'];
  for (const key of TOPOLOGY_DOCS) {
    it(`${CANONICAL[key]} classifies baseline, lane-final, integrated, and post-merge`, () => {
      const text = canonicalText(CANONICAL[key]);
      assert.match(text, /baseline/i);
      assert.match(text, /lane-final/i);
      assert.match(text, /integrated/i);
      assert.match(text, /post-merge/i);
      assert.match(text, /same command on different branch heads is different evidence/i);
    });
  }

  it('verification-evidence keeps strict baseline reuse bounds', () => {
    const text = canonicalText(CANONICAL.verification);
    assert.match(text, /Baseline reuse is narrow/i);
    assert.match(text, /can never prove a lane-final, integrated, review, acceptance, or post-merge final-state claim/i);
    assert.match(text, /identical and clean/i);
    assert.match(text, /must not silently convert stale evidence into fresh evidence/i);
  });

  it('parallel-delegation records per-check topology fields', () => {
    const text = canonicalText(CANONICAL.parallel);
    assert.match(text, /stable check id, exact command, purpose, owner, target artifact revision or tree/i);
    assert.match(text, /reuse eligibility, and rerun trigger/i);
    assert.match(text, /Baseline reuse never satisfies a lane-final, integrated, review, acceptance, or post-merge final-state claim/i);
    assert.match(text, /One verified base run may establish baseline state for multiple lanes/i);
  });
});

describe('test and validation surfaces are writable collision surfaces', () => {
  it('parallel-delegation states the test-surface ownership rule', () => {
    const text = canonicalText(CANONICAL.parallel);
    assert.match(text, /## Test And Validation Surfaces/);
    assert.match(text, /writable collision surfaces exactly like production files/i);
    assert.match(text, /not parallel-write eligible unless/i);
    assert.match(text, /combined into one lane/i);
    assert.match(text, /exclusively owned serial integration task/i);
  });

  it('task-record template treats test surfaces as parallel-safety data', () => {
    const text = canonicalText(CANONICAL.taskRecord);
    assert.match(text, /Test\/fixture\/snapshot\/shared-helper surfaces:/);
  });
});

describe('integration rehearsal is risk-triggered, engineer-owned, and non-publishing', () => {
  it('parallel-delegation defines the rehearsal and its boundaries', () => {
    const text = canonicalText(CANONICAL.parallel);
    assert.match(text, /## Integration Rehearsal/);
    assert.match(text, /risk-triggered combined-state proof/i);
    assert.match(text, /runs serially after all expected implementation artifacts have returned/i);
    assert.match(text, /engineer integration-verification lane/i);
    assert.match(text, /disposable, non-published candidate/i);
    assert.match(text, /must not update the protected default or integration branch/i);
    assert.match(text, /must not push, publish, open or merge a pull request, accept work/i);
    assert.match(text, /do not silently resolve them in the rehearsal/i);
    assert.match(text, /never merge authorization/i);
    assert.match(text, /If the eventual real merged tree differs from the rehearsed candidate/i);
    assert.match(text, /may omit the rehearsal with a recorded reason/i);
    assert.match(text, /Not every parallel batch needs an expensive full-suite rehearsal/i);
  });

  it('rehearsal liveness names an expected artifact and failure handling', () => {
    const text = canonicalText(CANONICAL.parallel);
    assert.match(text, /Rehearsal liveness/i);
    assert.match(text, /Its expected artifact is the rehearsal result/i);
    assert.match(text, /failed or blocked lane at join/i);
  });

  it('core methodology separates rehearsal from actual human-approved merge', () => {
    const text = canonicalText(CANONICAL.loop);
    assert.match(text, /Integration rehearsal/i);
    assert.match(text, /never bypasses the human merge checkpoint/i);
    assert.match(text, /not a merge and grants no merge, push, publish, or acceptance authority/i);
  });

  it('orchestrator authorizes and verifies the rehearsal without gaining merge authority', () => {
    const text = canonicalText(CANONICAL.orchestrator);
    assert.match(text, /integration-rehearsal engineer step/i);
    assert.match(text, /integrated evidence binds to the exact combined tree\/commit/i);
    assert.match(text, /rehearsal never pushes, publishes, merges, or accepts work/i);
  });

  it('engineer performs rehearsal only when explicitly assigned', () => {
    const text = canonicalText(CANONICAL.engineer);
    assert.match(text, /integration rehearsal only when the orchestrator explicitly assigns it/i);
    assert.match(text, /never authorizes pushing, publishing, accepting, or actually merging/i);
    assert.match(text, /conflict\/ordering result for the owning task branches/i);
  });

  it('backends keep rehearsal non-publishing and the human merge checkpoint', () => {
    const files = canonicalText(CANONICAL.filesBackend);
    assert.match(files, /explicitly planned integration rehearsal/i);
    assert.match(files, /not final integration/i);
    assert.match(files, /remains a human decision/i);
    const github = canonicalText(CANONICAL.githubBackend);
    assert.match(github, /disposable non-published candidate/i);
    assert.match(github, /never pushes, publishes, opens or merges a pull request/i);
    assert.match(github, /actual merged composition differs from the rehearsed candidate/i);
  });
});

describe('durable invariant promotion reuses the existing decision mechanism', () => {
  it('core methodology grades the promotion threshold', () => {
    const text = canonicalText(CANONICAL.loop);
    assert.match(text, /lane-local observation stays in that lane's status return or task summary/i);
    assert.match(text, /routed and disposed under the cross-lane finding rules/i);
    assert.match(text, /`status: proposed` decision record with provenance and a source link/i);
    assert.match(text, /Nothing in parallel work auto-promotes/i);
  });

  it('engineer decision creation is broader than verification scope but still bounded', () => {
    const text = canonicalText(CANONICAL.engineer);
    assert.match(text, /`scope: verification`/);
    assert.match(text, /`quality`, `architecture`, `process`/i);
    assert.match(text, /do not create records indiscriminately/i);
  });
});
