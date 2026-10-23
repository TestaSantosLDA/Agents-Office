import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  agentDefinitionsDir,
  findAgentDefinition,
  listAgentDefinitions,
  normalizeAgentDefinition,
  parseAgentDefinitionYaml,
  removeAgentDefinition,
  saveAgentDefinition,
  slugifyAgentName,
} from '../src/agents/agentDefinitions.js';
import {
  buildRolePrompt,
  concurrencyRefusal,
  planAgentLaunch,
  resolveLaunchDirectory,
} from '../src/agents/agentLaunch.js';
import {
  handleAgentDefinitionClientMessage,
  prepareDefinitionLaunch,
} from '../src/agents/agentMessages.js';
import { listLocalSkills, readSkillDescription } from '../src/agents/localSkills.js';
import { claudeProvider } from '../src/providers/index.js';

/**
 * Agent definitions (Agent Office phase 2): YAML files under
 * ~/.pixel-agents/agents, local skills, and how a definition becomes a launch.
 * $HOME is redirected to a fresh temp dir per test.
 */
describe('agent definitions', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let repo: string;
  let otherRepo: string;

  const writeSkill = (root: string, name: string, description?: string) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    const front = description ? `---\nname: ${name}\ndescription: ${description}\n---\n` : '';
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `${front}# ${name}\n`);
    return dir;
  };

  beforeEach(() => {
    tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-agents-test-')));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    repo = path.join(tempHome, 'work', 'lokaly-api');
    otherRepo = path.join(tempHome, 'work', 'lokaly-frontend');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(otherRepo, { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  describe('normalizeAgentDefinition', () => {
    it('requires a name and a role', () => {
      expect(normalizeAgentDefinition({ role: 'x' })).toEqual({
        ok: false,
        reason: 'Give the agent a name.',
      });
      expect(normalizeAgentDefinition({ name: 'Rita' })).toEqual({
        ok: false,
        reason: 'Give the agent a role.',
      });
      expect(normalizeAgentDefinition({ name: '!!!', role: 'x' }).ok).toBe(false);
    });

    it('trims, dedupes, expands ~ and drops empty fields', () => {
      const result = normalizeAgentDefinition({
        name: ' Rita ',
        role: 'bug-hunter',
        bestAt: '  ',
        tags: ['java', ' java ', '', 3],
        directories: ['~/work/lokaly-api', '~/work/lokaly-api/'],
        maxConcurrent: 0,
      });
      expect(result).toEqual({
        ok: true,
        definition: { name: 'Rita', role: 'bug-hunter', tags: ['java'], directories: [repo] },
      });
    });

    it('refuses a negative or fractional max concurrent', () => {
      expect(normalizeAgentDefinition({ name: 'R', role: 'r', maxConcurrent: -1 }).ok).toBe(false);
      expect(normalizeAgentDefinition({ name: 'R', role: 'r', maxConcurrent: 1.5 }).ok).toBe(false);
    });
  });

  it('slugifies names into file stems', () => {
    expect(slugifyAgentName('Rita the Bug Hunter!')).toBe('rita-the-bug-hunter');
  });

  it('reads the snake_case YAML from the plan', () => {
    const result = parseAgentDefinitionYaml(`name: Rita
role: bug-hunter
best_at: "Reproducing and fixing backend bugs in Java/Spring services"
tags: [java, spring, backend, bugs]
skills: [spring-boot-debugging, jira-ticket-reader]
tools: [Read, Edit, Bash, Grep]
model: sonnet
max_concurrent: 1
directories: [~/work/lokaly-api]
`);
    expect(result).toEqual({
      ok: true,
      definition: {
        name: 'Rita',
        role: 'bug-hunter',
        bestAt: 'Reproducing and fixing backend bugs in Java/Spring services',
        tags: ['java', 'spring', 'backend', 'bugs'],
        skills: ['spring-boot-debugging', 'jira-ticket-reader'],
        tools: ['Read', 'Edit', 'Bash', 'Grep'],
        model: 'sonnet',
        maxConcurrent: 1,
        directories: [repo],
      },
    });
    expect(parseAgentDefinitionYaml('- not\n- a mapping\n').ok).toBe(false);
  });

  describe('files', () => {
    it('saves, lists, renames and removes', () => {
      expect(listAgentDefinitions()).toEqual([]);
      expect(saveAgentDefinition({ name: 'Rita', role: 'bug-hunter', model: 'sonnet' }).ok).toBe(
        true,
      );
      expect(fs.readFileSync(path.join(agentDefinitionsDir(), 'rita.yaml'), 'utf-8')).toBe(
        'name: Rita\nrole: bug-hunter\nmodel: sonnet\n',
      );

      // A create with a taken name is refused, case-insensitively.
      expect(saveAgentDefinition({ name: 'RITA', role: 'other' })).toEqual({
        ok: false,
        reason: 'An agent called Rita already exists.',
      });

      // Editing in place keeps one file.
      expect(saveAgentDefinition({ name: 'Rita', role: 'reviewer' }, 'Rita').ok).toBe(true);
      expect(findAgentDefinition('rita')?.role).toBe('reviewer');

      // A rename moves the file.
      expect(saveAgentDefinition({ name: 'Rui', role: 'reviewer' }, 'Rita').ok).toBe(true);
      expect(fs.readdirSync(agentDefinitionsDir()).sort()).toEqual(['rui.yaml']);

      expect(removeAgentDefinition('Rui')).toEqual({ ok: true });
      expect(listAgentDefinitions()).toEqual([]);
    });

    it('skips unreadable files and finds hand-named ones', () => {
      fs.mkdirSync(agentDefinitionsDir(), { recursive: true });
      fs.writeFileSync(path.join(agentDefinitionsDir(), 'broken.yaml'), 'name: [');
      fs.writeFileSync(
        path.join(agentDefinitionsDir(), 'my-router.yml'),
        'name: Router\nrole: router\n',
      );
      expect(listAgentDefinitions()).toEqual([{ name: 'Router', role: 'router' }]);

      // Removing by name deletes the hand-named file, not a slug guess.
      expect(removeAgentDefinition('Router')).toEqual({ ok: true });
      expect(fs.existsSync(path.join(agentDefinitionsDir(), 'my-router.yml'))).toBe(false);
    });
  });

  describe('local skills', () => {
    it('lists user skills first, then each Directory, by folder name', () => {
      writeSkill(path.join(tempHome, '.claude', 'skills'), 'triage', 'Triage a Jira ticket');
      writeSkill(path.join(repo, '.claude', 'skills'), 'spring-boot-debugging');
      writeSkill(path.join(repo, '.claude', 'skills'), 'triage', 'shadowed by the user skill');
      fs.mkdirSync(path.join(repo, '.claude', 'skills', 'not-a-skill'), { recursive: true });

      expect(listLocalSkills([{ name: 'lokaly-api', path: repo }])).toEqual([
        {
          name: 'spring-boot-debugging',
          path: path.join(repo, '.claude', 'skills', 'spring-boot-debugging'),
          source: 'directory',
          directoryName: 'lokaly-api',
        },
        {
          name: 'triage',
          description: 'Triage a Jira ticket',
          path: path.join(tempHome, '.claude', 'skills', 'triage'),
          source: 'user',
        },
      ]);
    });

    it('reads no description from a SKILL.md without frontmatter', () => {
      const dir = writeSkill(tempHome, 'plain');
      expect(readSkillDescription(path.join(dir, 'SKILL.md'))).toBeUndefined();
    });
  });

  describe('launch planning', () => {
    it('resolves the Directory within what the definition allows', () => {
      const def = { name: 'Rita', role: 'r', directories: [repo] };
      expect(resolveLaunchDirectory(def, undefined, '/start')).toEqual({ ok: true, path: repo });
      expect(resolveLaunchDirectory(def, `${repo}/`, '/start')).toEqual({
        ok: true,
        path: `${repo}/`,
      });
      expect(resolveLaunchDirectory(def, otherRepo, '/start').ok).toBe(false);
      expect(resolveLaunchDirectory({ name: 'Any', role: 'r' }, undefined, '/start')).toEqual({
        ok: true,
        path: '/start',
      });
    });

    it('caps concurrency only when maxConcurrent is set', () => {
      expect(concurrencyRefusal({ name: 'R', role: 'r' }, 10)).toBeNull();
      expect(concurrencyRefusal({ name: 'R', role: 'r', maxConcurrent: 1 }, 0)).toBeNull();
      expect(concurrencyRefusal({ name: 'R', role: 'r', maxConcurrent: 1 }, 1)).toBe(
        'R is already running 1 of 1 allowed.',
      );
    });

    it('writes the role prompt', () => {
      expect(
        buildRolePrompt(
          {
            name: 'Router',
            role: 'router',
            bestAt: 'picking agents',
            prompt: 'Reply with one name.',
          },
          ['triage'],
        ),
      ).toBe(
        'You are Router, an agent in Agent Office. Role: router.\n' +
          'You are best at: picking agents.\n' +
          'Use these skills when they apply: triage.\n\nReply with one name.',
      );
    });

    it('loads only skills the CLI would not already see through a plugin dir', () => {
      writeSkill(path.join(tempHome, '.claude', 'skills'), 'triage');
      writeSkill(path.join(repo, '.claude', 'skills'), 'own');
      const foreignSkill = writeSkill(path.join(otherRepo, '.claude', 'skills'), 'figma-reader');
      const skills = listLocalSkills([
        { name: 'lokaly-api', path: repo },
        { name: 'lokaly-frontend', path: otherRepo },
      ]);
      const def = {
        name: 'Rita',
        role: 'bug-hunter',
        skills: ['triage', 'own', 'figma-reader', 'gone'],
        tools: ['Read', 'Edit'],
        model: 'sonnet',
      };

      const plan = planAgentLaunch(def, repo, skills);
      expect(plan.missingSkills).toEqual(['gone']);
      expect(plan.profile.model).toBe('sonnet');
      expect(plan.profile.tools).toEqual(['Read', 'Edit']);
      expect(plan.profile.appendSystemPrompt).toContain(
        'Use these skills when they apply: triage, own, figma-reader.',
      );
      expect(plan.profile.pluginDirs).toHaveLength(1);
      const pluginDir = plan.profile.pluginDirs![0];
      expect(fs.readdirSync(path.join(pluginDir, 'skills'))).toEqual(['figma-reader']);
      expect(fs.realpathSync(path.join(pluginDir, 'skills', 'figma-reader'))).toBe(
        fs.realpathSync(foreignSkill),
      );
      expect(
        JSON.parse(fs.readFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf-8'))
          .name,
      ).toBe('agent-rita');

      // Nothing foreign attached: no plugin dir at all.
      const bare = planAgentLaunch({ ...def, skills: ['triage'] }, repo, skills);
      expect(bare.profile.pluginDirs).toBeUndefined();
    });

    it('maps the profile to Claude Code flags', () => {
      const launch = claudeProvider.buildLaunchCommand!('sid', repo, {
        profile: {
          model: 'sonnet',
          tools: ['Read', 'Edit'],
          pluginDirs: ['/p'],
          appendSystemPrompt: 'You are Rita.',
        },
      });
      expect(launch.args).toEqual([
        '--session-id',
        'sid',
        '--model',
        'sonnet',
        '--tools',
        'Read,Edit',
        '--plugin-dir',
        '/p',
        '--append-system-prompt',
        'You are Rita.',
      ]);
    });

    it('prepares a launch, refusing unknown names, foreign Directories and a full cap', () => {
      saveAgentDefinition({
        name: 'Rita',
        role: 'bug-hunter',
        directories: [repo],
        maxConcurrent: 1,
      });
      const base = {
        definitionName: 'rita',
        requestedPath: undefined,
        fallbackPath: '/start',
        running: () => 0,
        skillDirectories: [],
      };
      const ok = prepareDefinitionLaunch(base);
      expect(ok.ok && ok.directoryPath).toBe(repo);
      expect(ok.ok && ok.definitionName).toBe('Rita');

      expect(prepareDefinitionLaunch({ ...base, definitionName: 'Nobody' })).toEqual({
        ok: false,
        reason: 'No agent called Nobody.',
      });
      expect(prepareDefinitionLaunch({ ...base, requestedPath: otherRepo }).ok).toBe(false);
      expect(prepareDefinitionLaunch({ ...base, running: () => 1 }).ok).toBe(false);
    });
  });

  describe('client messages', () => {
    it('saves and rebroadcasts, refuses with a reply, lists skills', () => {
      const broadcast: Record<string, unknown>[] = [];
      const reply: Record<string, unknown>[] = [];
      const deps = {
        broadcast: (m: Record<string, unknown>) => broadcast.push(m),
        reply: (m: Record<string, unknown>) => reply.push(m),
        skillDirectories: () => [],
      };

      expect(
        handleAgentDefinitionClientMessage(
          { type: 'saveAgentDefinition', definition: { name: 'Rita', role: 'bug-hunter' } },
          deps,
        ),
      ).toBe(true);
      expect(broadcast).toEqual([
        { type: 'agentDefinitionsLoaded', definitions: [{ name: 'Rita', role: 'bug-hunter' }] },
      ]);
      expect(reply).toEqual([
        { type: 'agentDefinitionSaved', definition: { name: 'Rita', role: 'bug-hunter' } },
      ]);

      handleAgentDefinitionClientMessage(
        { type: 'saveAgentDefinition', definition: { name: 'Rui' } },
        deps,
      );
      expect(reply.at(-1)).toEqual({
        type: 'agentDefinitionRejected',
        name: 'Rui',
        reason: 'Give the agent a role.',
      });

      handleAgentDefinitionClientMessage({ type: 'removeAgentDefinition', name: 'Rita' }, deps);
      expect(broadcast.at(-1)).toEqual({ type: 'agentDefinitionsLoaded', definitions: [] });

      handleAgentDefinitionClientMessage({ type: 'requestLocalSkills' }, deps);
      expect(reply.at(-1)).toEqual({ type: 'localSkillsLoaded', skills: [] });

      expect(handleAgentDefinitionClientMessage({ type: 'saveLayout' }, deps)).toBe(false);
    });
  });
});
