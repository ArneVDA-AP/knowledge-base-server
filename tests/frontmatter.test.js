import { describe, it } from 'node:test';
import assert from 'node:assert';
import { formatYamlTags } from '../src/utils/frontmatter.js';

describe('formatYamlTags', () => {
  it('should format tags as YAML block-list', () => {
    const result = formatYamlTags(['ai', 'agents', 'workflow']);
    assert.strictEqual(result, 'tags:\n  - ai\n  - agents\n  - workflow');
  });

  it('should return empty array syntax for no tags', () => {
    const result = formatYamlTags([]);
    assert.strictEqual(result, 'tags: []');
  });

  it('should handle single tag', () => {
    const result = formatYamlTags(['test']);
    assert.strictEqual(result, 'tags:\n  - test');
  });

  it('should trim whitespace from tag values', () => {
    const result = formatYamlTags([' ai ', ' agents']);
    assert.strictEqual(result, 'tags:\n  - ai\n  - agents');
  });

  it('should filter empty strings', () => {
    const result = formatYamlTags(['ai', '', 'agents']);
    assert.strictEqual(result, 'tags:\n  - ai\n  - agents');
  });

  it('should handle null/undefined input gracefully', () => {
    assert.strictEqual(formatYamlTags(null), 'tags: []');
    assert.strictEqual(formatYamlTags(undefined), 'tags: []');
  });

  it('should quote tags with YAML-special characters', () => {
    const result = formatYamlTags(['normal', 'has:colon', 'has#hash']);
    assert.strictEqual(result, 'tags:\n  - normal\n  - "has:colon"\n  - "has#hash"');
  });
});
