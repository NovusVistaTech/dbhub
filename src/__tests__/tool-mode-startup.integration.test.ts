import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import path from 'path';

describe('tool mode startup validation', () => {
  // Invoke tsx directly via node to avoid pnpm.cmd resolution issues on Windows.
  const tsxCli = path.resolve(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const entry = path.resolve(process.cwd(), 'src', 'index.ts');

  const start = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [tsxCli, entry, '--demo', ...args], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 10000,
    });

  it.each([
    ['an invalid DBHUB_TOOL_MODE', [], { DBHUB_TOOL_MODE: 'bogus' }],
    ['an invalid --tool-mode', ['--tool-mode=bogus'], {}],
  ])('exits at startup with %s', (_label, args, env) => {
    const result = start(['--transport=http', '--port=0', ...args], env);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Invalid tool mode 'bogus'");
  });
});
