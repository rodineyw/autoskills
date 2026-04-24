import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSkillPath } from "./lib.ts";
import type { SkillEntry } from "./lib.ts";
import { AGENT_FOLDER_MAP } from "./skills-map.ts";
import {
  log,
  write,
  dim,
  green,
  cyan,
  red,
  HIDE_CURSOR,
  SHOW_CURSOR,
  SPINNER,
} from "./colors.ts";

// ── Registry ─────────────────────────────────────────────────

export interface RegistryEntry {
  source: string;
  skillPath: string;
  commitSha: string;
  files: string[];
  sha256: Record<string, string>;
  bundleHash: string;
  review: {
    status: "approved" | "flagged";
    flags: string[];
    summary: string;
    model: string;
    promptVersion: string;
    reviewedAt: string;
  };
}

export interface Registry {
  version: number;
  generatedAt: string;
  reviewer: { model: string; promptVersion: string };
  skills: Record<string, RegistryEntry>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

let _cachedRegistry: Registry | null | undefined;
let _cachedRegistryDir: string | null = null;

export function getRegistryDir(): string {
  if (_cachedRegistryDir) return _cachedRegistryDir;
  const candidates = [
    join(__dirname, "skills-registry"),
    join(__dirname, "..", "skills-registry"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "index.json"))) {
      _cachedRegistryDir = c;
      return c;
    }
  }
  _cachedRegistryDir = candidates[0];
  return _cachedRegistryDir;
}

export function loadRegistry(): Registry | null {
  if (_cachedRegistry !== undefined) return _cachedRegistry;
  const manifestPath = join(getRegistryDir(), "index.json");
  try {
    const body = JSON.parse(readFileSync(manifestPath, "utf-8")) as Registry;
    _cachedRegistry = body;
    return body;
  } catch {
    _cachedRegistry = null;
    return null;
  }
}

/** @internal — exported for testing only */
export function _setRegistryDir(dir: string | null): void {
  _cachedRegistryDir = dir;
  _cachedRegistry = undefined;
}

// ── Integrity ────────────────────────────────────────────────

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function verifyRegistryEntry(
  skillName: string,
  entry: RegistryEntry,
  registryDir: string = getRegistryDir(),
): { ok: boolean; reason?: string } {
  const skillDir = join(registryDir, skillName);
  if (!existsSync(skillDir)) {
    return { ok: false, reason: `missing directory ${skillDir}` };
  }
  for (const rel of entry.files) {
    const abs = join(skillDir, rel);
    if (!existsSync(abs)) {
      return { ok: false, reason: `missing file ${rel}` };
    }
    const expected = entry.sha256[rel];
    if (!expected) {
      return { ok: false, reason: `no recorded hash for ${rel}` };
    }
    const actual = sha256File(abs);
    if (actual !== expected) {
      return { ok: false, reason: `hash mismatch for ${rel}` };
    }
  }
  return { ok: true };
}

// ── Install ──────────────────────────────────────────────────

export interface InstallResult {
  success: boolean;
  output: string;
  stderr: string;
  exitCode: number | null;
  command: string;
}

interface InstallOptions {
  projectDir?: string;
  registryDir?: string;
}

function relPathFromTo(from: string, to: string): string {
  const rel = relative(from, to);
  return rel.split("\\").join("/");
}

function copyFile(src: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

function ensureSymlinkTo(target: string, linkPath: string): void {
  mkdirSync(dirname(linkPath), { recursive: true });
  try {
    const st = statSync(linkPath);
    if (st) rmSync(linkPath, { recursive: true, force: true });
  } catch {}
  const rel = relPathFromTo(dirname(linkPath), target);
  try {
    symlinkSync(rel, linkPath, "dir");
  } catch {
    copyDir(target, linkPath);
  }
}

function copyDir(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, e.name);
    const d = join(dest, e.name);
    if (e.isDirectory()) {
      copyDir(s, d);
    } else if (e.isFile()) {
      copyFileSync(s, d);
    }
  }
}

export function agentFolderFor(agent: string): string | null {
  for (const [folder, name] of Object.entries(AGENT_FOLDER_MAP)) {
    if (name === agent) return folder;
  }
  return null;
}

function updateSkillsLock(
  projectDir: string,
  skillName: string,
  entry: RegistryEntry,
): void {
  const lockPath = join(projectDir, "skills-lock.json");
  let lock: { version: number; skills: Record<string, unknown> };
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf-8"));
    if (!lock || typeof lock !== "object" || !lock.skills) {
      lock = { version: 1, skills: {} };
    }
  } catch {
    lock = { version: 1, skills: {} };
  }
  lock.skills[skillName] = {
    source: entry.source,
    sourceType: "autoskills-registry",
    computedHash: entry.bundleHash,
  };
  const sortedSkills: Record<string, unknown> = {};
  for (const k of Object.keys(lock.skills).sort()) {
    sortedSkills[k] = lock.skills[k];
  }
  lock.skills = sortedSkills;
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
}

export async function installSkill(
  skillPath: string,
  agents: string[] = [],
  opts: InstallOptions = {},
): Promise<InstallResult> {
  const projectDir = opts.projectDir || process.cwd();
  const registryDir = opts.registryDir || getRegistryDir();
  const command = `autoskills install ${skillPath}`;

  const fail = (msg: string): InstallResult => ({
    success: false,
    output: msg,
    stderr: msg,
    exitCode: 1,
    command,
  });

  const { skillName } = parseSkillPath(skillPath);
  if (!skillName) return fail(`invalid skill path: ${skillPath}`);

  const registry = loadRegistry();
  if (!registry) {
    return fail(
      `skills-registry not found. Run 'pnpm sync:skills' in the autoskills package.`,
    );
  }

  const entry = registry.skills[skillName];
  if (!entry) {
    return fail(`skill '${skillName}' not found in registry (unaudited).`);
  }

  const verdict = verifyRegistryEntry(skillName, entry, registryDir);
  if (!verdict.ok) {
    return fail(`integrity check failed: ${verdict.reason}`);
  }

  const canonicalDir = join(projectDir, ".agents", "skills", skillName);
  try {
    rmSync(canonicalDir, { recursive: true, force: true });
    for (const rel of entry.files) {
      copyFile(join(registryDir, skillName, rel), join(canonicalDir, rel));
    }
  } catch (err) {
    return fail(`copy failed: ${(err as Error).message}`);
  }

  const uniqueFolders = new Set<string>();
  for (const agent of agents) {
    if (agent === "universal") continue;
    const folder = agentFolderFor(agent);
    if (folder) uniqueFolders.add(folder);
  }

  const symlinkErrors: string[] = [];
  for (const folder of uniqueFolders) {
    const linkPath = join(projectDir, folder, "skills", skillName);
    try {
      ensureSymlinkTo(canonicalDir, linkPath);
    } catch (err) {
      symlinkErrors.push(`${folder}: ${(err as Error).message}`);
    }
  }

  try {
    updateSkillsLock(projectDir, skillName, entry);
  } catch (err) {
    return fail(`lockfile update failed: ${(err as Error).message}`);
  }

  if (symlinkErrors.length > 0) {
    return {
      success: false,
      output: symlinkErrors.join("\n"),
      stderr: symlinkErrors.join("\n"),
      exitCode: 1,
      command,
    };
  }

  return {
    success: true,
    output: `installed ${skillName} into ${relPathFromTo(projectDir, canonicalDir)}`,
    stderr: "",
    exitCode: 0,
    command,
  };
}

// ── Batch install (concurrent + spinner) ─────────────────────

function sortByRepo(skills: SkillEntry[]): SkillEntry[] {
  return [...skills].sort((a, b) => {
    const repoA = parseSkillPath(a.skill).repo;
    const repoB = parseSkillPath(b.skill).repo;
    return repoA.localeCompare(repoB);
  });
}

interface InstallAllResult {
  installed: number;
  failed: number;
  errors: {
    name: string;
    output: string;
    stderr: string;
    exitCode: number | null;
    command: string;
  }[];
}

export async function installAll(
  skills: SkillEntry[],
  agents: string[] = [],
  opts: InstallOptions = {},
): Promise<InstallAllResult> {
  if (!process.stdout.isTTY) return installAllSimple(skills, agents, opts);

  const CONCURRENCY = 6;
  const sorted = sortByRepo(skills);
  const total = sorted.length;

  const states = sorted.map(({ skill }) => ({
    name: skill,
    skill,
    status: "pending" as "pending" | "installing" | "success" | "failed",
    output: "",
  }));

  let frame = 0;
  let rendered = false;
  let activeCount = 0;

  function render(): void {
    if (rendered) {
      write(`\x1b[${total}A\r`);
    }
    rendered = true;
    write("\x1b[J");

    for (const state of states) {
      switch (state.status) {
        case "pending":
          write(dim(`   ◌ ${state.name}`) + "\n");
          break;
        case "installing":
          write(cyan(`   ${SPINNER[frame]}`) + ` ${state.name}...\n`);
          break;
        case "success":
          write(green(`   ✔ ${state.name}`) + "\n");
          break;
        case "failed":
          write(red(`   ✘ ${state.name}`) + dim(" — failed") + "\n");
          break;
      }
    }
  }

  write(HIDE_CURSOR);

  const timer = setInterval(() => {
    frame = (frame + 1) % SPINNER.length;
    if (activeCount > 0) render();
  }, 80);

  let installed = 0;
  let failed = 0;
  const errors: InstallAllResult["errors"] = [];
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (nextIdx < total) {
      const idx = nextIdx++;
      const state = states[idx];
      state.status = "installing";
      activeCount++;
      render();

      const result = await installSkill(state.skill, agents, opts);

      activeCount--;
      if (result.success) {
        state.status = "success";
        installed++;
      } else {
        state.status = "failed";
        state.output = result.output;
        errors.push({
          name: state.name,
          output: result.output,
          stderr: result.stderr,
          exitCode: result.exitCode,
          command: result.command,
        });
        failed++;
      }
      render();
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker());
  await Promise.all(workers);

  clearInterval(timer);
  render();
  write(SHOW_CURSOR);

  return { installed, failed, errors };
}

async function installAllSimple(
  skills: SkillEntry[],
  agents: string[] = [],
  opts: InstallOptions = {},
): Promise<InstallAllResult> {
  const CONCURRENCY = 6;
  const sorted = sortByRepo(skills);
  let installed = 0;
  let failed = 0;
  const errors: InstallAllResult["errors"] = [];
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (nextIdx < sorted.length) {
      const idx = nextIdx++;
      const { skill } = sorted[idx];
      const result = await installSkill(skill, agents, opts);

      if (result.success) {
        log(green(`   ✔ ${skill}`));
        installed++;
      } else {
        log(red(`   ✘ ${skill}`) + dim(" — failed"));
        errors.push({
          name: skill,
          output: result.output,
          stderr: result.stderr,
          exitCode: result.exitCode,
          command: result.command,
        });
        failed++;
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, sorted.length) }, () => worker());
  await Promise.all(workers);

  return { installed, failed, errors };
}

// ── Deprecated shim ──────────────────────────────────────────

/** @deprecated retained so that UI code keeps compiling; no longer used. */
export function resolveSkillsBin(): string | null {
  return null;
}
