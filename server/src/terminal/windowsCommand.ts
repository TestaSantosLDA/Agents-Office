/**
 * Turn a bare command name (`claude`) into something Windows can start.
 *
 * Neither ConPTY nor `child_process.spawn` (without a shell) honours PATHEXT,
 * so on Windows a bare `claude` only starts when a `claude.exe` sits on PATH.
 * An npm install puts `claude.cmd` there instead, and a batch file is the
 * wrong thing to start anyway: cmd.exe re-parses its arguments, and the
 * multi-line prompts the task queue sends would be cut at the first newline.
 * So an npm shim is unwrapped to what it runs (`node <cli.js>` or the
 * package's own `.exe`), and only an unknown batch file falls back to cmd.exe.
 *
 * Elsewhere the command is returned unchanged.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface SpawnCommand {
  command: string;
  args: string[];
}

export interface ResolveCommandEnv {
  platform: NodeJS.Platform;
  pathVar: string | undefined;
  pathExt: string | undefined;
  nodePath: string;
  isFile: (file: string) => boolean;
  readFile: (file: string) => string | null;
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** The target an npm cmd-shim runs: `"%dp0%\node_modules\...\cli.js" %*`. */
const SHIM_TARGET = /"%~?dp0%?\\?([^"%]+\.(?:js|cjs|mjs|exe))"/gi;

function hostEnv(): ResolveCommandEnv {
  return {
    platform: process.platform,
    pathVar: process.env.PATH ?? process.env.Path,
    pathExt: process.env.PATHEXT,
    nodePath: process.execPath,
    isFile: (file) => {
      try {
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    },
    readFile: (file) => {
      try {
        return fs.readFileSync(file, 'utf-8');
      } catch {
        return null;
      }
    },
  };
}

export function resolveSpawnCommand(
  command: string,
  args: string[],
  env: ResolveCommandEnv = hostEnv(),
): SpawnCommand {
  if (env.platform !== 'win32') return { command, args };
  // Already a path or an explicit executable: the caller knows what it wants.
  if (/[\\/]/.test(command) || /\.(exe|com)$/i.test(command)) return { command, args };

  const win = path.win32;
  const exts = (env.pathExt || DEFAULT_PATHEXT)
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  let found: string | null = null;
  for (const dir of (env.pathVar ?? '').split(';').filter(Boolean)) {
    for (const ext of exts) {
      const candidate = win.join(dir, command + ext);
      if (env.isFile(candidate)) {
        found = candidate;
        break;
      }
    }
    if (found) break;
  }
  if (!found) return { command, args };

  const ext = win.extname(found).toLowerCase();
  if (ext === '.exe' || ext === '.com') return { command: found, args };

  // A batch file: unwrap an npm shim to what it starts. Its first quoted
  // target is usually the optional bundled node.exe, so skip that one.
  const text = env.readFile(found) ?? '';
  for (const match of text.matchAll(SHIM_TARGET)) {
    const target = win.join(win.dirname(found), match[1]);
    if (/(^|\\)node\.exe$/i.test(match[1]) || !env.isFile(target)) continue;
    return /\.exe$/i.test(target)
      ? { command: target, args }
      : { command: env.nodePath, args: [target, ...args] };
  }
  return { command: 'cmd.exe', args: ['/d', '/s', '/c', found, ...args] };
}
