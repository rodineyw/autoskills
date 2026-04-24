import { describe, it } from "node:test";
import { ok, equal, deepEqual } from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import {
  agentFolderFor,
  installSkill,
  verifyRegistryEntry,
  _setRegistryDir,
} from "../installer.ts";
import type { RegistryEntry } from "../installer.ts";
import { useTmpDir, writeFile } from "./helpers.ts";

function sha256(buf: string | Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function bundleHashOf(entry: { files: string[]; sha256: Record<string, string> }): string {
  return sha256(
    entry.files
      .map((f) => `${f}:${entry.sha256[f]}`)
      .sort()
      .join("\n"),
  );
}

interface FakeSkill {
  name: string;
  source: string;
  files: Record<string, string>;
}

function buildRegistry(dir: string, skills: FakeSkill[]): void {
  mkdirSync(dir, { recursive: true });
  const manifest: Record<string, unknown> = {
    version: 1,
    generatedAt: new Date().toISOString(),
    reviewer: { model: "test-model", promptVersion: "1.0.0" },
    skills: {} as Record<string, RegistryEntry>,
  };
  for (const skill of skills) {
    const shaMap: Record<string, string> = {};
    for (const [rel, content] of Object.entries(skill.files)) {
      const p = join(dir, skill.name, rel);
      mkdirSync(join(dir, skill.name, rel.split("/").slice(0, -1).join("/") || "."), {
        recursive: true,
      });
      writeFileSync(p, content);
      shaMap[rel] = sha256(content);
    }
    const entry: RegistryEntry = {
      source: skill.source,
      skillPath: `${skill.source}/${skill.name}`,
      commitSha: "deadbeef",
      files: Object.keys(skill.files).sort(),
      sha256: shaMap,
      bundleHash: bundleHashOf({ files: Object.keys(skill.files).sort(), sha256: shaMap }),
      review: {
        status: "approved",
        flags: [],
        summary: "test",
        model: "test-model",
        promptVersion: "1.0.0",
        reviewedAt: new Date().toISOString(),
      },
    };
    (manifest.skills as Record<string, RegistryEntry>)[skill.name] = entry;
  }
  writeFileSync(join(dir, "index.json"), JSON.stringify(manifest, null, 2));
}

describe("agentFolderFor", () => {
  it("maps claude-code to .claude", () => {
    equal(agentFolderFor("claude-code"), ".claude");
  });
  it("maps cursor to .cursor", () => {
    equal(agentFolderFor("cursor"), ".cursor");
  });
  it("returns null for unknown agents", () => {
    equal(agentFolderFor("nope"), null);
  });
});

describe("verifyRegistryEntry", () => {
  const tmp = useTmpDir();

  it("returns ok when hashes match", () => {
    const regDir = join(tmp.path, "registry");
    buildRegistry(regDir, [
      { name: "my-skill", source: "owner/repo", files: { "SKILL.md": "# hi" } },
    ]);
    _setRegistryDir(regDir);
    const manifest = JSON.parse(readFileSync(join(regDir, "index.json"), "utf-8"));
    const verdict = verifyRegistryEntry("my-skill", manifest.skills["my-skill"], regDir);
    ok(verdict.ok);
  });

  it("detects tampered file via hash mismatch", () => {
    const regDir = join(tmp.path, "registry");
    buildRegistry(regDir, [
      { name: "my-skill", source: "owner/repo", files: { "SKILL.md": "# hi" } },
    ]);
    writeFileSync(join(regDir, "my-skill", "SKILL.md"), "# tampered");
    _setRegistryDir(regDir);
    const manifest = JSON.parse(readFileSync(join(regDir, "index.json"), "utf-8"));
    const verdict = verifyRegistryEntry("my-skill", manifest.skills["my-skill"], regDir);
    ok(!verdict.ok);
    ok(verdict.reason?.includes("hash mismatch"));
  });

  it("detects missing file listed in manifest", () => {
    const regDir = join(tmp.path, "registry");
    buildRegistry(regDir, [
      { name: "my-skill", source: "owner/repo", files: { "SKILL.md": "# hi" } },
    ]);
    _setRegistryDir(regDir);
    const manifest = JSON.parse(readFileSync(join(regDir, "index.json"), "utf-8"));
    const entry = manifest.skills["my-skill"];
    entry.files.unshift("references/MISSING.md");
    entry.sha256["references/MISSING.md"] = "0".repeat(64);
    const verdict = verifyRegistryEntry("my-skill", entry, regDir);
    ok(!verdict.ok);
    ok(verdict.reason?.includes("missing"));
  });
});

describe("installSkill", () => {
  const tmp = useTmpDir();

  it("copies files to .agents/skills/<name> and updates lock", async () => {
    const regDir = join(tmp.path, "registry");
    const projectDir = join(tmp.path, "project");
    mkdirSync(projectDir, { recursive: true });
    buildRegistry(regDir, [
      {
        name: "hello-skill",
        source: "owner/repo",
        files: { "SKILL.md": "# hello", "references/notes.md": "notes" },
      },
    ]);
    _setRegistryDir(regDir);

    const result = await installSkill("owner/repo/hello-skill", [], {
      projectDir,
      registryDir: regDir,
    });

    ok(result.success, result.output);
    ok(existsSync(join(projectDir, ".agents", "skills", "hello-skill", "SKILL.md")));
    ok(existsSync(join(projectDir, ".agents", "skills", "hello-skill", "references", "notes.md")));

    const lock = JSON.parse(readFileSync(join(projectDir, "skills-lock.json"), "utf-8"));
    equal(lock.skills["hello-skill"].source, "owner/repo");
    equal(lock.skills["hello-skill"].sourceType, "autoskills-registry");
    ok(typeof lock.skills["hello-skill"].computedHash === "string");
  });

  it("creates symlinks for requested agents", async () => {
    const regDir = join(tmp.path, "registry");
    const projectDir = join(tmp.path, "project");
    mkdirSync(projectDir, { recursive: true });
    buildRegistry(regDir, [
      { name: "s1", source: "owner/repo", files: { "SKILL.md": "# s1" } },
    ]);
    _setRegistryDir(regDir);

    const result = await installSkill("owner/repo/s1", ["universal", "claude-code", "cursor"], {
      projectDir,
      registryDir: regDir,
    });
    ok(result.success, result.output);

    const claudeLink = join(projectDir, ".claude", "skills", "s1");
    const cursorLink = join(projectDir, ".cursor", "skills", "s1");
    ok(existsSync(claudeLink));
    ok(existsSync(cursorLink));

    const target = readlinkSync(claudeLink);
    ok(target.includes(".agents/skills/s1") || target.includes(".agents\\skills\\s1"));
  });

  it("rejects when skill is not in the registry", async () => {
    const regDir = join(tmp.path, "registry");
    const projectDir = join(tmp.path, "project");
    mkdirSync(projectDir, { recursive: true });
    buildRegistry(regDir, [
      { name: "known", source: "owner/repo", files: { "SKILL.md": "# known" } },
    ]);
    _setRegistryDir(regDir);

    const result = await installSkill("owner/repo/unknown", [], {
      projectDir,
      registryDir: regDir,
    });
    ok(!result.success);
    ok(result.output.includes("not found in registry"));
  });

  it("rejects when registry integrity check fails", async () => {
    const regDir = join(tmp.path, "registry");
    const projectDir = join(tmp.path, "project");
    mkdirSync(projectDir, { recursive: true });
    buildRegistry(regDir, [
      { name: "tampered", source: "owner/repo", files: { "SKILL.md": "# ok" } },
    ]);
    writeFileSync(join(regDir, "tampered", "SKILL.md"), "# evil");
    _setRegistryDir(regDir);

    const result = await installSkill("owner/repo/tampered", [], {
      projectDir,
      registryDir: regDir,
    });
    ok(!result.success);
    ok(result.output.includes("integrity check failed"));
  });

  it("preserves existing entries in skills-lock.json and sorts keys", async () => {
    const regDir = join(tmp.path, "registry");
    const projectDir = join(tmp.path, "project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "skills-lock.json"),
      JSON.stringify({
        version: 1,
        skills: { zebra: { source: "x/y", sourceType: "autoskills-registry", computedHash: "z" } },
      }),
    );
    buildRegistry(regDir, [
      { name: "alpha", source: "owner/repo", files: { "SKILL.md": "# a" } },
    ]);
    _setRegistryDir(regDir);

    const result = await installSkill("owner/repo/alpha", [], {
      projectDir,
      registryDir: regDir,
    });
    ok(result.success);

    const lock = JSON.parse(readFileSync(join(projectDir, "skills-lock.json"), "utf-8"));
    deepEqual(Object.keys(lock.skills), ["alpha", "zebra"]);
    equal(lock.skills.zebra.source, "x/y");
  });
});
