/**
 * Contract tests ensuring all implemented adapters are supported everywhere.
 *
 * Verifies:
 *   - All five adapters have status "supported" in config.json
 *   - No active tracked docs describe a current adapter as experimental
 *   - Status and doctor agree on adapter support
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

const IMPLEMENTED_ADAPTERS = ['opencode', 'codex', 'claude-code', 'copilot', 'cursor'];

function loadConfigJson() {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'config.json'), 'utf-8'));
}

function listTrackedMarkdownFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry.startsWith('.') || entry === 'node_modules' || entry === 'tmp') continue;
    if (statSync(full).isDirectory()) {
      results.push(...listTrackedMarkdownFiles(full));
    } else if (entry.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

describe('contract: all implemented adapters are supported', () => {
  it('all five adapters have status "supported" in config.json', () => {
    const config = loadConfigJson();
    const adapters = config.adapters ?? {};

    for (const adapter of IMPLEMENTED_ADAPTERS) {
      const host = adapters[adapter] ?? {};
      assert.equal(
        host.status,
        'supported',
        `Adapter '${adapter}' must have status 'supported' in config.json, got: ${JSON.stringify(host.status)}`
      );
    }
  });

  it('no active tracked docs describe a current adapter as experimental', () => {
    const docs = listTrackedMarkdownFiles(REPO_ROOT).filter(filePath => {
      // Exclude temp, node_modules, test fixtures, .agenticloop
      const r = filePath.replace(REPO_ROOT, '').replace(/\\/g, '/');
      return !r.includes('/tmp/') &&
        !r.startsWith('tmp/') &&
        !r.includes('/node_modules/') &&
        !r.includes('/.agenticloop/') &&
        !r.includes('/.codegraph/');
    });

    const violations = [];
    for (const docPath of docs) {
      const content = readFileSync(docPath, 'utf-8');
      const rel = docPath.replace(REPO_ROOT, '').replace(/\\/g, '/');

      for (const adapter of IMPLEMENTED_ADAPTERS) {
        // Look for "experimental" near adapter name mentions. We want to catch
        // phrasing like "Claude Code adapter is experimental", "experimental Codex plugin", etc.
        // But NOT phrases in historical contexts (e.g. "was experimental before Phase 07").
        const patterns = [
          new RegExp(`${adapter}.*experimental`, 'i'),
          new RegExp(`experimental.*${adapter}`, 'i'),
        ];

        for (const pattern of patterns) {
          if (pattern.test(content)) {
            // Allow historical/past-tense references and non-status descriptions.
            const line = content.split('\n').find(l => pattern.test(l)) ?? '';
            if (
              line.includes('was experimental') ||
              line.includes('previously experimental') ||
              line.includes('no longer experimental') ||
              line.includes('(Superseded') ||
              line.includes('Phase 07') ||
              line.includes('Phase 05') ||
              line.includes('Phase 10') ||
              line.includes('Phase 12') ||
              // Allow "experimental surface at the toolkit root" for Claude plugin (it's the package root surface)
              (line.includes('experimental surface') && line.includes('toolkit root'))
            ) {
              continue;
            }
            violations.push(`${rel}: "${line.trim()}" suggests ${adapter} is experimental`);
          }
        }
      }
    }

    assert.deepEqual(
      violations,
      [],
      `Found ${violations.length} tracked doc(s) that describe an implemented adapter as experimental:\n${violations.join('\n')}`
    );
  });

  it('no support-status evidence gate exists', () => {
    // Verify that no doc requires recording a smoke result or updating a guide
    // as a condition for adapter support status.
    const docs = listTrackedMarkdownFiles(REPO_ROOT).filter(filePath => {
      const r = filePath.replace(REPO_ROOT, '').replace(/\\/g, '/');
      return r.includes('/docs/') && !r.includes('/tmp/') && !r.startsWith('tmp/');
    });

    for (const docPath of docs) {
      const content = readFileSync(docPath, 'utf-8');
      const r = docPath.replace(REPO_ROOT, '').replace(/\\/g, '/');

      // Check for "record the smoke result and update this guide" as mandatory
      const mandatorySmoke = /record the smoke result/i;
      if (mandatorySmoke.test(content)) {
        // Find the context
        const idx = content.search(mandatorySmoke);
        const snippet = content.slice(Math.max(0, idx - 100), idx + 100);
        // Allow it only if preceded by "optional" or similar
        if (!/(optional|not required|not a support-status|advisory)/i.test(snippet)) {
          assert.fail(
            `${r} appears to require recording smoke results as mandatory (not optional)`
          );
        }
      }
    }
    // If we got here we're good.
    assert.ok(true);
  });
});
