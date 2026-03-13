import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  type ArchitectureSummaryArtifact,
  type ArchitectureSubsystem
} from "../../src/core/operations/mapArchitectureFromRepo.js";
import type { ProposalSummaryArtifact } from "../../src/core/operations/generateProposalBrief.js";
import {
  GenerateDeltaSpecError,
  runGenerateDeltaSpec
} from "../../src/core/operations/generateDeltaSpec.js";
import type { RepoProfileArtifact } from "../../src/core/operations/profileRepository.js";
import {
  ARTIFACT_OWNERSHIP_REGISTRY,
  inferArtifactKindFromId
} from "../../src/core/spec/ownership.js";

function buildRepoProfile(): RepoProfileArtifact {
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
    repository_root: "/workspace/app",
    scan: {
      max_files: 200,
      scanned_file_count: 6,
      truncated: false,
      ignored_directories: [".git", "node_modules"]
    },
    evidence: {
      top_level_entries: ["src", "tests", "package.json"],
      sampled_files: [
        "src/api/routes.ts",
        "src/api/service.ts",
        "src/cli/main.ts",
        "src/shared/types.ts",
        "tests/api/routes.test.ts",
        "tests/cli/main.test.ts"
      ],
      extension_counts: [
        { extension: ".ts", count: 6 }
      ],
      detected_manifests: ["package.json"],
      detected_tooling: ["node", "typescript", "pnpm"]
    }
  };
}

function buildArchitectureSummary(
  overrides?: Partial<ArchitectureSummaryArtifact>
): ArchitectureSummaryArtifact {
  const subsystems: ArchitectureSubsystem[] = [
    {
      id: "src/api",
      label: "src/api",
      inferred_responsibility: "API/backend surface",
      file_count: 2,
      evidence_refs: ["src/api/routes.ts", "src/api/service.ts"],
      uncertainty: "low"
    },
    {
      id: "src/cli",
      label: "src/cli",
      inferred_responsibility: "CLI entrypoints",
      file_count: 1,
      evidence_refs: ["src/cli/main.ts"],
      uncertainty: "medium"
    },
    {
      id: "tests/api",
      label: "tests/api",
      inferred_responsibility: "Test coverage",
      file_count: 1,
      evidence_refs: ["tests/api/routes.test.ts"],
      uncertainty: "medium"
    }
  ];

  return {
    kind: "architecture_summary",
    metadata: {
      artifact_id: "architecture_summary",
      artifact_version: "v1",
      created_timestamp: "2026-03-13T00:05:00.000Z",
      generator: "operation.mapArchitectureFromRepo",
      source_refs: [{ artifact_id: "repo_profile", artifact_version: "v2" }],
      checksum: "b".repeat(64)
    },
    project_mode: "existing-repo",
    repository_root: "/workspace/app",
    subsystems,
    summary_markdown: "# Architecture Summary"
  };
}

function buildProposalSummary(
  overrides?: Partial<ProposalSummaryArtifact>
): ProposalSummaryArtifact {
  return {
    kind: "proposal_summary_markdown",
    metadata: {
      artifact_id: "proposal_summary.md",
      artifact_version: "v1",
      created_timestamp: "2026-03-13T00:10:00.000Z",
      generator: "operation.generateProposalBrief",
      source_refs: [{ artifact_id: "idea_brief", artifact_version: "v4" }],
      checksum: "c".repeat(64)
    },
    source_refs: [{ artifact_id: "idea_brief", artifact_version: "v4" }],
    project_mode: "feature-proposal",
    repository_ownership: "external",
    sections: {
      problem: "Need to extend the API contract for downstream integrators.",
      requested_change: "Update src/api and related tests.",
      non_goals: "No CLI rewrite.",
      constraints_risks: "Preserve current public behavior.",
      success_signal: "Scoped review is possible.",
      unresolved_assumptions: "None."
    },
    content: "# Proposal Summary"
  };
}

describe("generateDeltaSpec failure paths", () => {
  it("fails with a typed error for unsupported project modes", async () => {
    await expect(
      runGenerateDeltaSpec({
        project_mode: "greenfield",
        change_summary: "Update API routes.",
        approved_scope: ["src/api"],
        repo_profile: buildRepoProfile(),
        architecture_summary: buildArchitectureSummary()
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<GenerateDeltaSpecError>>({
        code: "invalid_mode"
      })
    );
  });

  it("fails when an approved scope entry does not resolve to a known baseline area", async () => {
    await expect(
      runGenerateDeltaSpec({
        project_mode: "existing-repo",
        change_summary: "Update API routes.",
        approved_scope: ["src/mobile"],
        repo_profile: buildRepoProfile(),
        architecture_summary: buildArchitectureSummary()
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<GenerateDeltaSpecError>>({
        code: "invalid_scope"
      })
    );
  });

  it("fails in feature-proposal mode when proposal approval context is missing", async () => {
    await expect(
      runGenerateDeltaSpec({
        project_mode: "feature-proposal",
        change_summary: "Update API routes.",
        approved_scope: ["src/api"],
        repo_profile: buildRepoProfile(),
        architecture_summary: buildArchitectureSummary()
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<GenerateDeltaSpecError>>({
        code: "insufficient_proposal_summary"
      })
    );
  });
});

describe("generateDeltaSpec success paths", () => {
  it("generates a deterministic delta spec with explicit baseline refs for existing repos", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "specforge-delta-spec-"));

    const result = await runGenerateDeltaSpec({
      project_mode: "existing-repo",
      change_summary: "Refine the API routing flow without touching the CLI.",
      approved_scope: ["src/api", "tests/api"],
      repo_profile: buildRepoProfile(),
      architecture_summary: buildArchitectureSummary(),
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-13T12:00:00.000Z")
    });

    expect(result.delta_spec.kind).toBe("delta_spec");
    expect(result.delta_spec.metadata.artifact_id).toBe("delta_spec");
    expect(result.delta_spec.metadata.artifact_version).toBe("v1");
    expect(result.delta_spec.baseline_refs).toEqual([
      { artifact_id: "repo_profile", artifact_version: "v2" },
      { artifact_id: "architecture_summary", artifact_version: "v1" }
    ]);
    expect(result.delta_spec.approved_scope).toEqual(["src/api", "tests/api"]);
    expect(result.delta_spec.impacted_subsystems.map((entry) => entry.subsystem_id)).toEqual([
      "src/api",
      "tests/api"
    ]);
    expect(result.delta_spec.excluded_subsystems).toEqual(["src/cli"]);
    expect(result.delta_spec.summary_markdown).toContain("Only explicitly approved scope is included.");

    const written = JSON.parse(
      await readFile(join(artifactDir, ".specforge", "delta_spec.json"), "utf8")
    );
    expect(written.metadata.artifact_id).toBe("delta_spec");
    expect(written.approved_scope).toEqual(["src/api", "tests/api"]);
  });

  it("includes proposal summary as a baseline ref in feature-proposal mode", async () => {
    const result = await runGenerateDeltaSpec({
      project_mode: "feature-proposal",
      change_summary: "Refine the API routing flow without touching the CLI.",
      approved_scope: ["src/api"],
      repo_profile: buildRepoProfile(),
      architecture_summary: buildArchitectureSummary(),
      proposal_summary: buildProposalSummary(),
      proposal_summary_status: "approved"
    });

    expect(result.delta_spec.baseline_refs).toEqual([
      { artifact_id: "repo_profile", artifact_version: "v2" },
      { artifact_id: "architecture_summary", artifact_version: "v1" },
      { artifact_id: "proposal_summary.md", artifact_version: "v1" }
    ]);
    expect(result.delta_spec.summary_markdown).toContain("Proposal Baseline: proposal_summary.md@v1");
  });

  it("registers delta_spec ownership and increments versions on subsequent runs", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "specforge-delta-spec-version-"));

    await runGenerateDeltaSpec({
      project_mode: "existing-repo",
      change_summary: "Refine the API routing flow without touching the CLI.",
      approved_scope: ["src/api"],
      repo_profile: buildRepoProfile(),
      architecture_summary: buildArchitectureSummary(),
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-13T12:10:00.000Z")
    });

    const second = await runGenerateDeltaSpec({
      project_mode: "existing-repo",
      change_summary: "Refine the API routing flow without touching the CLI.",
      approved_scope: ["src/api"],
      repo_profile: buildRepoProfile(),
      architecture_summary: buildArchitectureSummary(),
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-13T12:15:00.000Z")
    });

    expect(ARTIFACT_OWNERSHIP_REGISTRY.delta_spec.owner_operation).toBe(
      "operation.generateDeltaSpec"
    );
    expect(inferArtifactKindFromId("delta_spec")).toBe("delta_spec");
    expect(second.delta_spec.metadata.artifact_version).toBe("v2");
    expect(second.delta_spec.metadata.parent_version).toBe("v1");
  });
});
