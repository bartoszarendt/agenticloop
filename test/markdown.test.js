import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  hasMarkdownHeading,
  markdownLinks,
  markdownSection,
  topLevelListItems,
} from '../src/markdown.js';

describe('Markdown structure helpers', () => {
  it('recognizes closing hashes and ignores heading text inside fences', () => {
    const markdown = '```md\n## Hidden\n```\n\n## Live ##\nbody';
    assert.equal(hasMarkdownHeading(markdown, '## Hidden'), false);
    assert.equal(hasMarkdownHeading(markdown, '## Live'), true);
  });

  it('ends a section at an indented same-level heading', () => {
    const section = markdownSection('## First\nbody\n   ## Second\nother', '## First');
    assert.equal(section?.body, 'body');
  });

  it('joins wrapped list items without promoting nested bullets', () => {
    const items = topLevelListItems([
      '- Manual check: compare the final design',
      '  against the role matrix.',
      '  - supporting detail',
      '- `npm test`',
    ].join('\n'));
    assert.deepEqual(items, [
      'Manual check: compare the final design against the role matrix. - supporting detail',
      '`npm test`',
    ]);
  });

  it('extracts wrapped-label and reference-style links outside fences', () => {
    const links = markdownLinks([
      '[wrapped',
      'label](docs/guide.md)',
      '[reference][guide]',
      '[guide]',
      '[guide]: docs/reference.md',
      '```md',
      '[ignored](docs/ignored.md)',
      '```',
    ].join('\n'));
    assert.deepEqual(links, [
      { url: 'docs/guide.md', line: 1 },
      { url: 'docs/reference.md', line: 3 },
      { url: 'docs/reference.md', line: 4 },
    ]);
  });
});
