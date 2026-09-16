import fs from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every package that survives to runtime must be declared in package.json.
 *
 * Two ways to lose one, both invisible under npm and both fatal under pnpm's strict
 * `node_modules`, which is what Glama's Docker build uses:
 *
 * 1. `src/` imports a package nobody declared. `src/cli/agents/lifecycle.ts` imported
 *    `stream-chain` while only `stream-json` was declared; npm hoists `stream-json`'s own
 *    dependency to the top of `node_modules`, so the bare specifier resolved by accident.
 *    Under pnpm it is simply not there, and the build died with `Could not resolve
 *    "stream-chain"`.
 * 2. A package tsup keeps EXTERNAL is reached transitively. `libsql` is imported by the bundled
 *    `@libsql/client`, not by us, and was never declared -- so the build succeeded and the
 *    server died on its first import with `Cannot find package 'libsql'`. The build is the
 *    louder failure; this one is the worse one.
 *
 * Both blocked the Glama release for five weeks, which blocked the quality score, which blocked
 * the awesome-mcp-servers listing. Every other check in this repo runs on the hoisted npm tree
 * and cannot see either.
 */
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'src');

/** Static imports, re-exports, dynamic `import()` and `require()` — anything that resolves. */
const SPECIFIER = /^\s*(?:import|export)[^;\n]*?\sfrom\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/gm;

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const found = await Promise.all(entries.map(async entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  }));
  return found.flat();
}

/** `@scope/name/deep/path` -> `@scope/name`; `name/deep/path` -> `name`. */
function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

describe('runtime dependencies', () => {
  it('declares every package src/ imports', async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ]);
    const builtins = new Set(builtinModules);

    const undeclared: string[] = [];
    for (const file of await sourceFiles(SRC)) {
      const source = await fs.readFile(file, 'utf8');
      for (const match of source.matchAll(SPECIFIER)) {
        const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
        if (!specifier) continue;
        if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) continue;
        const name = packageNameOf(specifier);
        if (builtins.has(name) || declared.has(name)) continue;
        undeclared.push(`${path.relative(ROOT, file).replaceAll('\\', '/')} imports '${specifier}'`);
      }
    }

    expect(undeclared, [
      'These packages resolve here only because npm hoists them out of another package.',
      'Add each to "dependencies" in package.json, or the pnpm-based Docker build fails.',
    ].join('\n')).toEqual([]);
  });

  it('declares every package tsup leaves external', async () => {
    // The externals are what `dist/` still imports by bare specifier at runtime. Some are ours
    // and some, like `libsql`, arrive only through a bundled dependency -- so scanning `src/`
    // cannot see them and the build stays green while the server cannot start.
    const config = await fs.readFile(path.join(ROOT, 'tsup.config.ts'), 'utf8');
    const externalBlock = config.match(/external:\s*\[([^\]]*)\]/s)?.[1] ?? '';
    const externals = [...externalBlock.matchAll(/'([^']+)'/g)].map(match => match[1]!);
    expect(externals.length, 'tsup.config.ts external list not found').toBeGreaterThan(0);

    const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ]);

    expect(
      externals.filter(name => !declared.has(name)),
      'An external is not bundled, so it must be installed at the user\'s end too.',
    ).toEqual([]);
  });

  it('detects an undeclared import introduced in a new file', async () => {
    // A guard that cannot fail is not a guard.
    const probe = path.join(SRC, 'core', '__dependency-probe__.ts');
    await fs.writeFile(probe, "import chain from 'definitely-not-a-dependency';\n");
    try {
      const source = await fs.readFile(probe, 'utf8');
      const specifiers = [...source.matchAll(SPECIFIER)].map(m => m[1] ?? m[2] ?? m[3] ?? m[4]);
      expect(specifiers).toEqual(['definitely-not-a-dependency']);
    } finally {
      await fs.rm(probe, { force: true });
    }
  });
});
