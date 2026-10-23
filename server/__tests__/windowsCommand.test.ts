import { describe, expect, it } from 'vitest';

import { type ResolveCommandEnv, resolveSpawnCommand } from '../src/terminal/windowsCommand.js';

/**
 * Starting `claude` on Windows, where ConPTY and spawn ignore PATHEXT: a
 * `claude.exe` is used as is, an npm `claude.cmd` shim is unwrapped to what it
 * runs (cmd.exe would cut multi-line prompts at the first newline).
 */
describe('resolveSpawnCommand', () => {
  const NPM_SHIM = [
    '@ECHO off',
    'SETLOCAL',
    'SET dp0=%~dp0',
    'IF EXIST "%dp0%\\node.exe" (SET "_prog=%dp0%\\node.exe") ELSE (SET "_prog=node")',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  ].join('\r\n');

  const env = (
    files: Record<string, string>,
    extra: Partial<ResolveCommandEnv> = {},
  ): ResolveCommandEnv => ({
    platform: 'win32',
    pathVar: 'C:\\Windows\\system32;C:\\Users\\a\\AppData\\Roaming\\npm',
    pathExt: '.COM;.EXE;.BAT;.CMD',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    isFile: (f) => f in files,
    readFile: (f) => files[f] ?? null,
    ...extra,
  });
  const npmDir = 'C:\\Users\\a\\AppData\\Roaming\\npm';
  const cliJs = `${npmDir}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;

  it('leaves other platforms alone', () => {
    expect(resolveSpawnCommand('claude', ['-p', 'x'], env({}, { platform: 'linux' }))).toEqual({
      command: 'claude',
      args: ['-p', 'x'],
    });
  });

  it('uses a claude.exe found on PATH', () => {
    const exe = 'C:\\Users\\a\\.local\\bin\\claude.exe';
    const result = resolveSpawnCommand(
      'claude',
      ['--session-id', 's'],
      env({ [exe]: '' }, { pathVar: 'C:\\Users\\a\\.local\\bin' }),
    );
    expect(result).toEqual({ command: exe, args: ['--session-id', 's'] });
  });

  it('unwraps an npm shim to node and its script, keeping newlines in arguments', () => {
    const result = resolveSpawnCommand(
      'claude',
      ['-p', 'line one\nline two'],
      env({ [`${npmDir}\\claude.cmd`]: NPM_SHIM, [cliJs]: '' }),
    );
    expect(result).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: [cliJs, '-p', 'line one\nline two'],
    });
  });

  it('starts the package exe when the shim points at one', () => {
    const exe = `${npmDir}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
    const shim =
      '@ECHO off\r\n"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';
    const result = resolveSpawnCommand(
      'claude',
      ['a'],
      env({ [`${npmDir}\\claude.cmd`]: shim, [exe]: '' }),
    );
    expect(result).toEqual({ command: exe, args: ['a'] });
  });

  it('falls back to cmd.exe for a batch file it does not recognise', () => {
    const cmd = `${npmDir}\\claude.cmd`;
    const result = resolveSpawnCommand('claude', ['a'], env({ [cmd]: '@echo hi' }));
    expect(result).toEqual({ command: 'cmd.exe', args: ['/d', '/s', '/c', cmd, 'a'] });
  });

  it('leaves a command it cannot find for spawn to report', () => {
    expect(resolveSpawnCommand('claude', [], env({}))).toEqual({ command: 'claude', args: [] });
  });
});
