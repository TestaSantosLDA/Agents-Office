/**
 * One-shot headless runs for the pipeline steps (triage, router): spawn the
 * provider's print-mode command, collect stdout, and give up after a timeout.
 * They run on the user's own CLI login like every other agent, and their
 * sessions show up in the office like any other headless session.
 */

import { spawn } from 'child_process';

import type { HookProvider, LaunchProfile } from '../../../core/src/provider.js';
import { resolveSpawnCommand } from '../terminal/windowsCommand.js';

/** Long enough for a triage that follows Confluence and Figma links. */
export const HEADLESS_RUN_TIMEOUT_MS = 15 * 60 * 1000;
/** Keep a runaway output from growing without bound; the tail is what matters. */
const MAX_OUTPUT_CHARS = 200_000;

export type HeadlessResult = { ok: true; output: string } | { ok: false; reason: string };

export type HeadlessRun = (
  prompt: string,
  cwd: string,
  profile: LaunchProfile,
) => Promise<HeadlessResult>;

export function createHeadlessRunner(
  provider: HookProvider,
  bypassPermissions: () => boolean,
  timeoutMs: number = HEADLESS_RUN_TIMEOUT_MS,
): HeadlessRun {
  return (prompt, cwd, profile) =>
    new Promise((resolve) => {
      const command = provider.buildHeadlessCommand?.(prompt, cwd, {
        bypassPermissions: bypassPermissions(),
        profile,
      });
      if (!command) {
        resolve({ ok: false, reason: `${provider.displayName} cannot run headless.` });
        return;
      }
      let output = '';
      let errors = '';
      let settled = false;
      const finish = (result: HeadlessResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      let child;
      try {
        // Windows: unwraps an npm .cmd shim, which spawn cannot start.
        const resolved = resolveSpawnCommand(command.command, command.args);
        child = spawn(resolved.command, resolved.args, {
          cwd,
          env: { ...process.env, ...command.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        resolve({ ok: false, reason: `Could not start ${command.command}: ${String(err)}` });
        return;
      }
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish({ ok: false, reason: `Gave up after ${Math.round(timeoutMs / 60000)} minutes.` });
      }, timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-MAX_OUTPUT_CHARS);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        errors = (errors + chunk.toString()).slice(-2000);
      });
      child.on('error', (err) =>
        finish({ ok: false, reason: `Could not run ${command.command}: ${err.message}` }),
      );
      child.on('close', (code) => {
        if (code === 0) finish({ ok: true, output: output.trim() });
        else
          finish({
            ok: false,
            reason: `Exited with ${code}: ${(errors || output).trim().slice(-300)}`,
          });
      });
    });
}
