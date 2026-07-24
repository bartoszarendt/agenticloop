import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  TOOLKIT_SOURCE_RELATIVE_PATHS,
  toPackageSourcePath,
} from '../../src/layout.js';

const TEST_TARGET_CONFIG = {
  extends: './agenticloop/config.json',
  adapters: {
    opencode: {
      roleSettings: {
        orchestrator: {
          model: 'test/opencode-orchestrator',
          reasoningEffort: 'high',
        },
        maintainer: {
          model: 'test/opencode-maintainer',
          reasoningEffort: 'max',
        },
        engineer: {
          model: 'test/opencode-engineer',
          reasoningEffort: 'high',
        },
        auditor: {
          model: 'test/opencode-auditor',
          reasoningEffort: 'high',
        },
      },
    },
    codex: {
      roleSettings: {
        orchestrator: {
          model: 'gpt-5.4',
          reasoningEffort: 'high',
        },
        maintainer: {
          model: 'gpt-5.5',
          reasoningEffort: 'xhigh',
        },
        engineer: {
          model: 'gpt-5.4',
          reasoningEffort: 'xhigh',
        },
        auditor: {
          model: 'gpt-5.5',
          reasoningEffort: 'xhigh',
        },
      },
    },
    'claude-code': {
      roleSettings: {
        orchestrator: {
          model: 'test/claude-orchestrator',
        },
        maintainer: {
          model: 'test/claude-maintainer',
        },
        engineer: {
          model: 'test/claude-engineer',
        },
        auditor: {
          model: 'test/claude-auditor',
        },
      },
    },
  },
};

export function copyTree(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const sourcePath = join(src, entry);
    const destPath = join(dest, entry);
    if (statSync(sourcePath).isDirectory()) {
      copyTree(sourcePath, destPath);
    } else {
      copyFileSync(sourcePath, destPath);
    }
  }
}

export function seedToolkitSource(repoRoot, targetDir) {
  for (const installedRelPath of TOOLKIT_SOURCE_RELATIVE_PATHS) {
    const sourcePath = join(repoRoot, toPackageSourcePath(installedRelPath));
    const targetPath = join(targetDir, installedRelPath);
    if (statSync(sourcePath).isDirectory()) {
      copyTree(sourcePath, targetPath);
    } else {
      mkdirSync(dirname(targetPath), { recursive: true });
      copyFileSync(sourcePath, targetPath);
    }
  }
}

export function seedTargetDocs(_repoRoot, targetDir) {
  // Self-contained stubs: fixtures only need these target docs to exist by
  // name, not the toolkit's local-only internal planning docs. Decoupled so
  // relocating internal plans cannot break tests.
  const docs = {
    'AGENTS.md': '# Agents\n\nProject rules.\n',
    'IMPLEMENTATION_PLAN.md': '# Implementation Plan\n\n## Phase 1\n\nWork items.\n',
    'README.md': '# Project\n\nOverview.\n',
  };
  for (const [filename, content] of Object.entries(docs)) {
    writeFileSync(join(targetDir, filename), content, 'utf-8');
  }
}

export function seedTargetConfig(_repoRoot, targetDir) {
  writeFileSync(
    join(targetDir, 'agenticloop.json'),
    JSON.stringify(TEST_TARGET_CONFIG, null, 2) + '\n',
    'utf-8'
  );
}

export function seedScratch(targetDir, content = '.agenticloop/tmp/\n') {
  mkdirSync(join(targetDir, '.agenticloop', 'tmp'), { recursive: true });
  writeFileSync(join(targetDir, '.gitignore'), content, 'utf-8');
}

export function seedTargetLayout(repoRoot, targetDir, options = {}) {
  const {
    includeDocs = true,
    includeConfig = true,
    includeScratch = true,
  } = options;

  seedToolkitSource(repoRoot, targetDir);
  if (includeDocs) {
    seedTargetDocs(repoRoot, targetDir);
  }
  if (includeConfig) {
    seedTargetConfig(repoRoot, targetDir);
  }
  if (includeScratch) {
    seedScratch(targetDir);
  }
}
