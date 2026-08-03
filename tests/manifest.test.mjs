import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { describe } from 'node:test';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PLUGIN_DIR = path.join(ROOT, 'plugins', 'agy');

const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));

const marketplace = readJson('.claude-plugin/marketplace.json');
const plugin = readJson('plugins/agy/.claude-plugin/plugin.json');

/** Extract YAML-ish frontmatter without pulling in a parser. */
function frontmatter(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return null;

  const fields = {};
  for (const line of match[1].split('\n')) {
    const pair = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (pair) fields[pair[1]] = pair[2].trim();
  }
  return fields;
}

const commandFiles = fs
  .readdirSync(path.join(PLUGIN_DIR, 'commands'))
  .filter((name) => name.endsWith('.md'))
  .map((name) => path.join(PLUGIN_DIR, 'commands', name));

describe('marketplace manifest', () => {
  test('points at a plugin directory that exists', () => {
    for (const entry of marketplace.plugins) {
      const source = path.join(ROOT, entry.source);
      assert.ok(fs.existsSync(source), `missing plugin source ${entry.source}`);
      assert.ok(fs.existsSync(path.join(source, '.claude-plugin', 'plugin.json')));
    }
  });

  test('agrees with the plugin manifest on name and version', () => {
    const entry = marketplace.plugins.find((candidate) => candidate.name === plugin.name);
    assert.ok(entry, `marketplace has no entry for "${plugin.name}"`);
    assert.equal(entry.version, plugin.version);
  });

  test('declares an owner', () => {
    assert.ok(marketplace.owner?.name);
  });
});

describe('command files', () => {
  test('every command ships frontmatter with a description', () => {
    for (const file of commandFiles) {
      const fields = frontmatter(file);
      assert.ok(fields, `${path.basename(file)} has no frontmatter`);
      assert.ok(fields.description, `${path.basename(file)} has no description`);
    }
  });

  test('the documented command set is present', () => {
    const names = commandFiles.map((file) => path.basename(file, '.md')).sort();
    for (const expected of ['cancel', 'delegate', 'look', 'research', 'result', 'review', 'setup', 'status', 'survey']) {
      assert.ok(names.includes(expected), `missing command: ${expected}`);
    }
  });

  test('commands invoke the companion through CLAUDE_PLUGIN_ROOT', () => {
    // A hardcoded path would break the moment the plugin is installed
    // somewhere other than this checkout.
    for (const file of commandFiles) {
      const text = fs.readFileSync(file, 'utf8');
      if (!text.includes('agy-companion.mjs')) continue;
      assert.ok(
        text.includes('${CLAUDE_PLUGIN_ROOT}'),
        `${path.basename(file)} references the companion without CLAUDE_PLUGIN_ROOT`,
      );
    }
  });
});

describe('agent and skills', () => {
  test('the delegate agent restricts itself to Bash', () => {
    const fields = frontmatter(path.join(PLUGIN_DIR, 'agents', 'agy-delegate.md'));
    assert.ok(fields, 'agy-delegate.md has no frontmatter');
    assert.equal(fields.tools, 'Bash');
  });

  test('internal skills are not user-invocable', () => {
    const skill = frontmatter(path.join(PLUGIN_DIR, 'skills', 'agy-cli-runtime', 'SKILL.md'));
    assert.equal(skill['user-invocable'], 'false');
  });

  test('every skill declares a name and description', () => {
    const skillsDir = path.join(PLUGIN_DIR, 'skills');
    for (const name of fs.readdirSync(skillsDir)) {
      const fields = frontmatter(path.join(skillsDir, name, 'SKILL.md'));
      assert.ok(fields?.name, `${name} skill has no name`);
      assert.ok(fields?.description, `${name} skill has no description`);
    }
  });
});

describe('review findings schema', () => {
  const schema = readJson('plugins/agy/schemas/review-findings.schema.json');

  test('parses and requires findings', () => {
    assert.ok(schema.required.includes('findings'));
  });

  test('forces every finding to declare whether its evidence was executed', () => {
    const finding = schema.properties.findings.items;
    assert.ok(finding.required.includes('evidence'));
    assert.deepEqual(finding.properties.evidence.enum, ['verified', 'illustrative']);
  });

  test('requires coverage reporting so blind spots are explicit', () => {
    assert.ok(schema.required.includes('coverage'));
    assert.ok(schema.properties.coverage.required.includes('not_examined'));
  });
});
