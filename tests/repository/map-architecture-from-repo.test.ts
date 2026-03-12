import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  MapArchitectureFromRepoError,
  runMapArchitectureFromRepo
} from "../../src/core/operations/mapArchitectureFromRepo.js";
import type { RepoProfileArtifact } from "../../src/core/operations/profileRepository.js";
import { ARTIFACT_OWNERSHIP_REGISTRY } from "../../src/core/spec/ownership.js";

function buildRepoProfile(overrides?: Partial<RepoProfileArtifact>): RepoProfileArtifact {
  return {
    kind: "repo_profile",
    metadata: {
      artifact_id: "repo_profile",
      artifact_version: "v2",
      created_timestamp: "2026-03-13T00:00:00.000Z",
      generator: "operation.profileRepository",
      source_refs: [],
      checksum: "a".repeat(64)
    },
    project_mode: "existing-repo",
    repository_root: "/tmp/example-repo",
    scan: {
      max_files: 20,
      scanned_file_count: 6,
      truncated: false,
      ignored_directories: [".git", ".specforge", "node_modules"]
    },
    evidence: {
      top_level_entries: ["README.md", "infra", "src", "tests"],
      sampled_files: [
        "src/api/routes.ts",
        "src/api/service.ts",
        "src/cli/main.ts",
        "infra/terraform/main.tf",
        "tests/api/routes.test.ts",
        "README.md"
      ],
      extension_counts: [
        { extension: ".ts", count: 4 },
        { extension: ".tf", count: 1 },
        { extension: ".md", count: 1 }
      ],
      detected_manifests: ["package.json", "tsconfig.json"],
      detected_tooling: ["node", "typescript"]
    },
    ...overrides
  };
}

describe("mapArchitectureFromRepo failure paths", () => {
  it("fails with typed invalid_mode when mode is not existing-repo", async () => {
    await expect(
      runMapArchitectureFromRepo({
        project_mode: "greenfield",
        repo_profile: buildRepoProfile()
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<MapArchitectureFromRepoError>>({
        code: "invalid_mode"
      })
    );
  });

  it("fails with typed error when repo_profile is missing", async () => {
    await expect(
      runMapArchitectureFromRepo({
        project_mode: "existing-repo"
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<MapArchitectureFromRepoError>>({
        code: "insufficient_repo_profile"
      })
    );
  });
});

describe("mapArchitectureFromRepo success paths", () => {
  it("registers architecture_summary ownership to operation.mapArchitectureFromRepo", () => {
    expect(ARTIFACT_OWNERSHIP_REGISTRY.architecture_summary.owner_operation).toBe(
      "operation.mapArchitectureFromRepo"
    );
  });

  it("produces deterministic subsystem boundaries with explicit evidence basis", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "specforge-architecture-"));

    const result = await runMapArchitectureFromRepo({
      project_mode: "existing-repo",
      repo_profile: buildRepoProfile(),
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-13T00:10:00.000Z")
    });

    expect(result.architecture_summary.kind).toBe("architecture_summary");
    expect(result.architecture_summary.metadata.artifact_id).toBe("architecture_summary");
    expect(result.architecture_summary.metadata.artifact_version).toBe("v1");
    expect(result.architecture_summary.metadata.generator).toBe("operation.mapArchitectureFromRepo");

    expect(result.architecture_summary.subsystems.map((subsystem) => subsystem.id)).toEqual([
      "infra/terraform",
      "src/api",
      "src/cli",
      "tests/api"
    ]);

    expect(result.architecture_summary.subsystems[0]).toEqual(
      expect.objectContaining({
        id: "infra/terraform",
        evidence_refs: ["infra/terraform/main.tf"],
        uncertainty: "medium"
      })
    );
    expect(result.architecture_summary.subsystems[1]).toEqual(
      expect.objectContaining({
        id: "src/api",
        evidence_refs: ["src/api/routes.ts", "src/api/service.ts"],
        uncertainty: "low"
      })
    );

    expect(result.architecture_summary.summary_markdown).toContain("# Architecture Summary");
    expect(result.architecture_summary.summary_markdown).toContain("## src/api");
    expect(result.architecture_summary.summary_markdown).toContain("Evidence");

    const written = JSON.parse(
      await readFile(join(artifactDir, ".specforge", "architecture_summary.json"), "utf8")
    );
    expect(written.metadata.artifact_id).toBe("architecture_summary");
    expect(written.subsystems).toHaveLength(4);
  });

  it("increments architecture summary version on subsequent runs", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "specforge-architecture-"));

    await runMapArchitectureFromRepo({
      project_mode: "existing-repo",
      repo_profile: buildRepoProfile(),
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-13T00:20:00.000Z")
    });

    const second = await runMapArchitectureFromRepo({
      project_mode: "existing-repo",
      repo_profile: buildRepoProfile(),
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-13T00:25:00.000Z")
    });

    expect(second.architecture_summary.metadata.artifact_version).toBe("v2");
    expect(second.architecture_summary.metadata.parent_version).toBe("v1");
  });
});
