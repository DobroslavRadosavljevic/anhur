#!/usr/bin/env bun
/**
 * Local release tooling for synced `@anhur/*` packages.
 *
 * Bun does not apply `publishConfig.exports` / `bin` when packing (unlike
 * yarn/pnpm). This script overlays those fields for pack/publish, then
 * restores `package.json`.
 *
 * Auth: `bun publish --auth-type web` (npm browser 2FA / web login).
 *
 * `pack` / `prepare` / `publish` always run publish gates (source shape,
 * dist artifacts, real pack + tarball inspection) so an invalid package
 * cannot be published.
 */
import { spawn } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = path.join(rootDir, "packages");

/** Publish order: dependents after dependencies. */
const PUBLISH_ORDER = [
  "@anhur/core",
  "@anhur/assets",
  "@anhur/markdown",
  "@anhur/mdx",
  "@anhur/orama",
  "@anhur/vite",
] as const;

/** Subpath exports that must exist on the published package. */
const REQUIRED_EXPORTS: Record<(typeof PUBLISH_ORDER)[number], readonly string[]> = {
  "@anhur/core": ["."],
  "@anhur/assets": ["."],
  "@anhur/markdown": ["."],
  "@anhur/mdx": [".", "./react"],
  "@anhur/orama": [".", "./client"],
  "@anhur/vite": ["."],
};

type PackageJson = {
  name: string;
  version: string;
  private?: boolean;
  description?: string;
  license?: string;
  type?: string;
  files?: string[];
  bin?: Record<string, string> | string;
  exports?: unknown;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, unknown>;
  scripts?: unknown;
  devDependencies?: unknown;
  inlinedDependencies?: unknown;
  engines?: { node?: string };
  publishConfig?: {
    access?: string;
    exports?: unknown;
    bin?: Record<string, string> | string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

type PackageInfo = {
  name: (typeof PUBLISH_ORDER)[number];
  dir: string;
  pkgPath: string;
  pkg: PackageJson;
};

class PublishCheckError extends Error {
  constructor(
    readonly packageName: string,
    readonly problems: string[],
  ) {
    super(`${packageName}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "PublishCheckError";
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadPublishablePackages(): Promise<PackageInfo[]> {
  const entries = await readdir(packagesDir, { withFileTypes: true });
  const packages: PackageInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(packagesDir, entry.name);
    const pkgPath = path.join(dir, "package.json");
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as PackageJson;
      if (pkg.private) continue;
      if (!pkg.name?.startsWith("@anhur/")) continue;
      packages.push({
        name: pkg.name as PackageInfo["name"],
        dir,
        pkgPath,
        pkg,
      });
    } catch {
      // skip
    }
  }

  const byName = new Map(packages.map((p) => [p.name, p]));
  const ordered: PackageInfo[] = [];
  for (const name of PUBLISH_ORDER) {
    const info = byName.get(name);
    if (!info) {
      throw new Error(`Expected publishable package missing: ${name}`);
    }
    ordered.push(info);
    byName.delete(name);
  }
  if (byName.size > 0) {
    throw new Error(`Publishable packages not in PUBLISH_ORDER: ${[...byName.keys()].join(", ")}`);
  }
  return ordered;
}

function assertSyncedVersions(packages: PackageInfo[]): string {
  const versions = new Set(packages.map((p) => p.pkg.version));
  if (versions.size !== 1) {
    const detail = packages.map((p) => `${p.name}@${p.pkg.version}`).join(", ");
    throw new Error(`Package versions are not synced: ${detail}`);
  }
  return packages[0]!.pkg.version;
}

async function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? rootDir,
      env: options.env ?? process.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

async function runCapture(command: string, args: string[], cwd: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}\n${stderr || stdout}`));
    });
  });
}

/** Resolve `exports` map values to relative file paths (ignore `package.json` self-export). */
function collectExportFiles(exportsField: unknown): Map<string, string> {
  const out = new Map<string, string>();

  const take = (subpath: string, value: unknown): void => {
    if (typeof value === "string") {
      out.set(subpath, value);
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    // Prefer import/default/types order for the JS file; types alone is not the runtime entry.
    const runtime =
      record.import ?? record.default ?? record.require ?? record.node ?? record.browser;
    if (typeof runtime === "string") {
      out.set(subpath, runtime);
      return;
    }
    if (runtime && typeof runtime === "object") {
      take(subpath, runtime);
    }
  };

  if (typeof exportsField === "string") {
    out.set(".", exportsField);
    return out;
  }
  if (!exportsField || typeof exportsField !== "object") return out;

  for (const [key, value] of Object.entries(exportsField as Record<string, unknown>)) {
    take(key, value);
  }
  return out;
}

function declarationForJs(jsRelative: string): string {
  if (jsRelative.endsWith(".js")) return `${jsRelative.slice(0, -3)}.d.ts`;
  if (jsRelative.endsWith(".mjs")) return `${jsRelative.slice(0, -4)}.d.mts`;
  if (jsRelative.endsWith(".cjs")) return `${jsRelative.slice(0, -4)}.d.cts`;
  return `${jsRelative}.d.ts`;
}

function binEntries(bin: PackageJson["bin"] | undefined): Array<[string, string]> {
  if (!bin) return [];
  if (typeof bin === "string") return [["anhur", bin]];
  return Object.entries(bin);
}

function workspaceProtocolProblems(
  label: string,
  deps: Record<string, string> | undefined,
): string[] {
  if (!deps) return [];
  const problems: string[] = [];
  for (const [name, version] of Object.entries(deps)) {
    if (version.includes("workspace:")) {
      problems.push(`${label}.${name} still uses workspace protocol (${version})`);
    }
  }
  return problems;
}

function buildPublishPackageJson(original: PackageJson): PackageJson {
  const pkg = structuredClone(original);
  const publish = pkg.publishConfig ?? {};

  if (publish.exports) {
    pkg.exports = publish.exports;
  }
  if (publish.bin) {
    pkg.bin = publish.bin;
  }
  pkg.publishConfig = {
    access: publish.access ?? "public",
  };

  delete pkg.scripts;
  delete pkg.devDependencies;
  delete pkg.inlinedDependencies;
  return pkg;
}

/**
 * Overlay `publishConfig.exports` / `bin` onto the package for Bun pack/publish.
 * Restores the original file afterward.
 */
async function withPublishOverlay<T>(info: PackageInfo, fn: () => Promise<T>): Promise<T> {
  const original = await readFile(info.pkgPath, "utf8");
  const pkg = buildPublishPackageJson(JSON.parse(original) as PackageJson);

  const exportsJson = JSON.stringify(pkg.exports ?? {});
  if (exportsJson.includes("./src/")) {
    throw new Error(
      `${info.name}: publish overlay still points exports at ./src/ — rebuild with tsdown exports.devExports`,
    );
  }

  await writeFile(info.pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  try {
    return await fn();
  } finally {
    await writeFile(info.pkgPath, original);
  }
}

/** Published CLI must run under Node (consumers may not have Bun). */
async function ensureCliNodeShebang(coreDir: string): Promise<void> {
  const cliPath = path.join(coreDir, "dist", "cli.js");
  if (!(await exists(cliPath))) {
    throw new Error(`Missing ${cliPath} — run build first`);
  }
  const source = await readFile(cliPath, "utf8");
  if (source.startsWith("#!/usr/bin/env bun")) {
    await writeFile(cliPath, source.replace(/^#!\/usr\/bin\/env bun\n/, "#!/usr/bin/env node\n"));
  }
}

async function assertDistReady(info: PackageInfo): Promise<void> {
  const distDir = path.join(info.dir, "dist");
  if (!(await exists(distDir))) {
    throw new Error(`Missing dist/ for ${info.name} — run build first`);
  }
  const files = await readdir(distDir);
  if (files.length === 0) {
    throw new Error(`Empty dist for ${info.name}`);
  }
}

/** Local workspace package.json must stay JIT-friendly and publishConfig-ready. */
function checkSourcePackage(info: PackageInfo): string[] {
  const { pkg, name } = info;
  const problems: string[] = [];

  if (pkg.private) problems.push("package is private");
  if (pkg.type !== "module") problems.push(`type must be "module" (got ${String(pkg.type)})`);
  if (!pkg.description?.trim()) problems.push("missing description");
  if (pkg.license !== "MIT") problems.push(`license must be MIT (got ${String(pkg.license)})`);
  if (!pkg.files?.includes("dist")) problems.push('files[] must include "dist"');
  if (!pkg.engines?.node) problems.push("missing engines.node");

  const localExports = JSON.stringify(pkg.exports ?? {});
  if (!localExports.includes("./src/")) {
    problems.push("local exports must point at ./src/ for JIT workspace installs");
  }
  if (localExports.includes("./dist/")) {
    problems.push("local exports must not point at ./dist/ (publishConfig owns dist)");
  }

  const publish = pkg.publishConfig;
  if (!publish?.exports) {
    problems.push("missing publishConfig.exports");
  } else {
    const publishExports = JSON.stringify(publish.exports);
    if (publishExports.includes("./src/")) {
      problems.push("publishConfig.exports must not point at ./src/");
    }
    if (publishExports.includes(".mjs") || publishExports.includes(".d.mts")) {
      problems.push('publishConfig.exports must use .js / .d.ts (not .mjs) with "type":"module"');
    }
    const exportFiles = collectExportFiles(publish.exports);
    for (const subpath of REQUIRED_EXPORTS[name]) {
      const target = exportFiles.get(subpath);
      if (!target) {
        problems.push(`publishConfig.exports missing required subpath "${subpath}"`);
        continue;
      }
      if (subpath !== "./package.json" && !target.startsWith("./dist/")) {
        problems.push(`publishConfig.exports["${subpath}"] must be under ./dist/ (got ${target})`);
      }
      if (target.endsWith(".js") === false && subpath !== "./package.json") {
        problems.push(`publishConfig.exports["${subpath}"] must end with .js (got ${target})`);
      }
    }
  }

  if (publish?.access && publish.access !== "public") {
    problems.push(`publishConfig.access must be public (got ${publish.access})`);
  }

  if (name === "@anhur/core") {
    const localBin = binEntries(pkg.bin);
    const publishBin = binEntries(publish?.bin);
    if (localBin.length === 0) problems.push("missing bin.anhur for local JIT");
    if (publishBin.length === 0) problems.push("missing publishConfig.bin.anhur");
    for (const [, target] of localBin) {
      if (!target.includes("/src/")) {
        problems.push(`local bin must point at ./src/ (got ${target})`);
      }
    }
    for (const [, target] of publishBin) {
      if (target !== "./dist/cli.js") {
        problems.push(`publishConfig.bin must be ./dist/cli.js (got ${target})`);
      }
    }
  } else if (pkg.bin || publish?.bin) {
    problems.push("unexpected bin field on non-CLI package");
  }

  return problems;
}

/** Built dist must contain every published export, matching .d.ts, and a Node CLI shebang. */
async function checkDistArtifacts(info: PackageInfo): Promise<string[]> {
  const problems: string[] = [];
  const publishExports = info.pkg.publishConfig?.exports;
  if (!publishExports) return ["missing publishConfig.exports"];

  const exportFiles = collectExportFiles(publishExports);
  for (const [subpath, relative] of exportFiles) {
    if (relative === "./package.json") continue;
    const abs = path.join(info.dir, relative);
    if (!(await exists(abs))) {
      problems.push(`missing dist file for exports["${subpath}"]: ${relative}`);
      continue;
    }
    if (relative.endsWith(".js")) {
      const dtsRel = declarationForJs(relative);
      if (!(await exists(path.join(info.dir, dtsRel)))) {
        problems.push(`missing declaration for exports["${subpath}"]: ${dtsRel}`);
      }
    }
  }

  for (const [, relative] of binEntries(info.pkg.publishConfig?.bin)) {
    const abs = path.join(info.dir, relative);
    if (!(await exists(abs))) {
      problems.push(`missing bin file: ${relative}`);
      continue;
    }
    const source = await readFile(abs, "utf8");
    if (!source.startsWith("#!/usr/bin/env node\n")) {
      problems.push(`bin ${relative} must start with #!/usr/bin/env node`);
    }
    if (source.startsWith("#!/usr/bin/env bun")) {
      problems.push(`bin ${relative} still has a Bun shebang`);
    }
  }

  return problems;
}

/** Packed package.json + tarball contents must be installable and lean. */
async function checkPackedPackage(
  info: PackageInfo,
  packedPkg: PackageJson,
  packageRoot: string,
): Promise<string[]> {
  const problems: string[] = [];

  if (packedPkg.name !== info.name) {
    problems.push(`packed name mismatch (${packedPkg.name})`);
  }
  if (packedPkg.version !== info.pkg.version) {
    problems.push(`packed version mismatch (${packedPkg.version})`);
  }
  if (packedPkg.type !== "module") problems.push('packed type must be "module"');
  if (packedPkg.scripts) problems.push("packed package.json must not include scripts");
  if (packedPkg.devDependencies) {
    problems.push("packed package.json must not include devDependencies");
  }
  if (packedPkg.inlinedDependencies) {
    problems.push("packed package.json must not include inlinedDependencies");
  }

  const packedExports = JSON.stringify(packedPkg.exports ?? {});
  if (packedExports.includes("./src/")) {
    problems.push("packed exports still point at ./src/");
  }
  if (packedExports.includes(".mjs") || packedExports.includes(".d.mts")) {
    problems.push("packed exports must use .js / .d.ts");
  }

  const access = packedPkg.publishConfig?.access;
  if (access !== "public") {
    problems.push(`packed publishConfig.access must be public (got ${String(access)})`);
  }
  if (packedPkg.publishConfig?.exports || packedPkg.publishConfig?.bin) {
    problems.push("packed publishConfig must only set access (exports/bin already overlaid)");
  }

  problems.push(...workspaceProtocolProblems("dependencies", packedPkg.dependencies));
  problems.push(...workspaceProtocolProblems("peerDependencies", packedPkg.peerDependencies));

  for (const required of ["package.json", "LICENSE", "README.md"] as const) {
    if (!(await exists(path.join(packageRoot, required)))) {
      problems.push(`tarball missing ${required}`);
    }
  }

  const exportFiles = collectExportFiles(packedPkg.exports);
  for (const subpath of REQUIRED_EXPORTS[info.name]) {
    const target = exportFiles.get(subpath);
    if (!target) {
      problems.push(`packed exports missing "${subpath}"`);
      continue;
    }
    if (!(await exists(path.join(packageRoot, target)))) {
      problems.push(`tarball missing exports["${subpath}"] file ${target}`);
      continue;
    }
    if (target.endsWith(".js")) {
      const dtsRel = declarationForJs(target);
      if (!(await exists(path.join(packageRoot, dtsRel)))) {
        problems.push(`tarball missing declaration ${dtsRel} for exports["${subpath}"]`);
      }
    }
  }

  for (const [binName, relative] of binEntries(packedPkg.bin)) {
    const abs = path.join(packageRoot, relative);
    if (!(await exists(abs))) {
      problems.push(`tarball missing bin.${binName} file ${relative}`);
      continue;
    }
    const source = await readFile(abs, "utf8");
    if (!source.startsWith("#!/usr/bin/env node\n")) {
      problems.push(`packed bin.${binName} must start with #!/usr/bin/env node`);
    }
  }

  if (info.name !== "@anhur/core" && packedPkg.bin) {
    problems.push("packed non-CLI package unexpectedly has bin");
  }

  return problems;
}

async function packToTemp(info: PackageInfo): Promise<{
  tarballPath: string;
  extractDir: string;
  packageRoot: string;
  packedPkg: PackageJson;
  fileList: string;
}> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "anhur-release-"));
  try {
    const packOut = await withPublishOverlay(info, async () =>
      runCapture("bun", ["pm", "pack", "--destination", tempRoot], info.dir),
    );
    const tarballName = packOut
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.endsWith(".tgz"));
    if (!tarballName) {
      throw new Error(`${info.name}: bun pm pack did not print a .tgz name\n${packOut}`);
    }
    const tarballPath = path.join(tempRoot, path.basename(tarballName));
    if (!(await exists(tarballPath))) {
      throw new Error(`${info.name}: packed tarball missing at ${tarballPath}`);
    }

    const extractDir = path.join(tempRoot, "extract");
    await run("mkdir", ["-p", extractDir]);
    await run("tar", ["-xzf", tarballPath, "-C", extractDir]);
    const packageRoot = path.join(extractDir, "package");
    const packedPkg = JSON.parse(
      await readFile(path.join(packageRoot, "package.json"), "utf8"),
    ) as PackageJson;
    const fileList = await runCapture("find", [packageRoot, "-type", "f"], packageRoot);

    return { tarballPath, extractDir, packageRoot, packedPkg, fileList };
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

async function assertPublishable(info: PackageInfo): Promise<void> {
  const problems = [...checkSourcePackage(info), ...(await checkDistArtifacts(info))];

  if (!(await exists(path.join(info.dir, "LICENSE")))) {
    problems.push("missing LICENSE");
  }
  if (!(await exists(path.join(info.dir, "README.md")))) {
    problems.push("missing README.md");
  }

  if (problems.length > 0) {
    throw new PublishCheckError(info.name, problems);
  }

  const packed = await packToTemp(info);
  try {
    const packedProblems = await checkPackedPackage(info, packed.packedPkg, packed.packageRoot);
    if (packedProblems.length > 0) {
      throw new PublishCheckError(info.name, packedProblems);
    }

    const relativeFiles = packed.fileList
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((abs) => path.relative(packed.packageRoot, abs))
      .filter((rel) => rel && !rel.startsWith(".."))
      .sort();

    console.log(`\n${info.name} OK (${relativeFiles.length} files)`);
    for (const file of relativeFiles) {
      console.log(`  ${file}`);
    }
  } finally {
    await rm(path.dirname(packed.extractDir), { recursive: true, force: true });
  }
}

async function verifyAll(packages: PackageInfo[]): Promise<void> {
  console.log("\n→ publish gates (source + dist + packed tarball)");
  for (const info of packages) {
    await assertDistReady(info);
    if (info.name === "@anhur/core") {
      await ensureCliNodeShebang(info.dir);
      // Reload shebang-sensitive checks after possible rewrite.
      info.pkg = JSON.parse(await readFile(info.pkgPath, "utf8")) as PackageJson;
    }
    await assertPublishable(info);
  }
}

async function setAllVersions(version: string): Promise<void> {
  const packages = await loadPublishablePackages();
  for (const info of packages) {
    const raw = await readFile(info.pkgPath, "utf8");
    const pkg = JSON.parse(raw) as PackageJson;
    pkg.version = version;
    await writeFile(info.pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    console.log(`set ${info.name} → ${version}`);
  }
}

async function qualityGates(): Promise<void> {
  console.log("\n→ format");
  await run("bun", ["run", "format"]);
  console.log("\n→ lint");
  await run("bun", ["run", "lint"]);
  console.log("\n→ check-types");
  await run("bun", ["run", "check-types"]);
  console.log("\n→ test");
  await run("bun", ["run", "test"]);
  console.log("\n→ test:integration");
  await run("bun", ["run", "test:integration"]);
}

async function buildPackages(): Promise<void> {
  console.log("\n→ build (@anhur/*)");
  await run("bun", ["run", "build", ...PUBLISH_ORDER.map((name) => `--filter=${name}`)]);
}

async function publishAll(packages: PackageInfo[]): Promise<void> {
  console.log("\n→ publish (bun publish --auth-type web)");
  for (const info of packages) {
    await assertDistReady(info);
    if (info.name === "@anhur/core") {
      await ensureCliNodeShebang(info.dir);
    }
    console.log(`\nPublishing ${info.name}@${info.pkg.version}…`);
    await withPublishOverlay(info, async () => {
      await run("bun", ["publish", "--auth-type", "web", "--access", "public"], { cwd: info.dir });
    });
  }
}

function printHelp(): void {
  console.log(`Usage: bun scripts/release.ts <command> [args]

Commands:
  sync-check              Assert all @anhur/* versions match
  version <semver>        Set every publishable package to the same version
  verify                  Build + publish gates (source/dist/tarball)
  prepare                 Quality gates + build + publish gates
  pack                    Build + publish gates (alias of verify)
  publish                 prepare, then bun publish --auth-type web (local only)

Publish gates fail the release if exports/bin/types/LICENSE/README/workspace
protocols/shebang/packed package.json shape are invalid.

Publishable packages (lockstep versions):
  ${PUBLISH_ORDER.join(", ")}
`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "-h" || command === "--help") {
    printHelp();
    process.exit(command ? 0 : 1);
  }

  if (command === "version") {
    const version = rest[0];
    if (!version || !/^\d+\.\d+\.\d+([\w.-]*)?$/.test(version)) {
      throw new Error("Usage: bun scripts/release.ts version <semver>");
    }
    await setAllVersions(version);
    return;
  }

  const packages = await loadPublishablePackages();
  const version = assertSyncedVersions(packages);
  console.log(`Synced version: ${version}`);
  console.log(packages.map((p) => `  ${p.name}`).join("\n"));

  if (command === "sync-check") {
    console.log("OK — versions match");
    return;
  }

  if (command === "verify" || command === "pack") {
    await buildPackages();
    const refreshed = await loadPublishablePackages();
    assertSyncedVersions(refreshed);
    await verifyAll(refreshed);
    console.log(`\n${command} OK`);
    return;
  }

  if (command === "prepare") {
    await qualityGates();
    await buildPackages();
    const refreshed = await loadPublishablePackages();
    assertSyncedVersions(refreshed);
    await verifyAll(refreshed);
    console.log("\nprepare OK — ready for: bun scripts/release.ts publish");
    return;
  }

  if (command === "publish") {
    await qualityGates();
    await buildPackages();
    const refreshed = await loadPublishablePackages();
    assertSyncedVersions(refreshed);
    await verifyAll(refreshed);
    await publishAll(refreshed);
    console.log("\npublish OK");
    return;
  }

  printHelp();
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
