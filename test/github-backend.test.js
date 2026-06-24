import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { loadJsonFile } from '../src/json.js';
import { extractTaskIdFromTitle } from '../src/github-backend.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

describe('GitHub backend title prefix extraction', () => {
  it('extracts multi-segment task ids from issue and PR titles', () => {
    const config = loadJsonFile(join(REPO_ROOT, 'config.json'));
    const regex = config.backends.github.titlePrefixRegex;

    assert.equal(extractTaskIdFromTitle('P7-01 Add setup confirmation', regex), 'P7-01');
    assert.equal(extractTaskIdFromTitle('P6-FU-1 Add backend evidence review', regex), 'P6-FU-1');
    assert.equal(extractTaskIdFromTitle('P3-10-FU-1 Fix export mismatch', regex), 'P3-10-FU-1');
    assert.equal(extractTaskIdFromTitle('P2-FU-A10 Tighten validation', regex), 'P2-FU-A10');
    assert.equal(extractTaskIdFromTitle('CI-01 Refresh checks', regex), 'CI-01');
    assert.equal(extractTaskIdFromTitle('FOUND-001 Update toolkit defaults', regex), 'FOUND-001');
  });
});
