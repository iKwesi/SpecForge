import { describe, expect, it } from "vitest";

import { analyzeRepositoryRisk } from "../../src/core/diagnostics/riskAnalysis.js";
import type { ArchitectureSummaryArtifact } from "../../src/core/operations/mapArchitectureFromRepo.js";
import type { RepoProfileArtifact } from "../../src/core/operations/profileRepository.js";

describe("repository risk analysis", () => {
  it("produces deterministic hotspot scores from complexity, coverage, and uncertainty providers", () => {
    const repoProfile = createRepoProfile({
      sampled_files: [
        "src/api/routes.ts",
        "src/api/service.ts",
        "src/api/controller.ts",
        "src/cli/main.ts",
        "src/cli/format.ts",
        "tests/api/routes.test.ts"
      ]
    });
    const architectureSummary = createArchitectureSummary({
      subsystems: [
        {
          id: "src/api",
          label: "src/api",
          inferred_responsibility: "API/backend surface",
          file_count: 3,
          evidence_refs: [
            "src/api/controller.ts",
            "src/api/routes.ts",
            "src/api/service.ts"
          ],
          uncertainty: "low"
        },
        {
          id: "src/cli",
          label: "src/cli",
          inferred_responsibility: "CLI entrypoints",
          file_count: 2,
          evidence_refs: ["src/cli/format.ts", "src/cli/main.ts"],
          uncertainty: "medium"
        },
        {
          id: "tests/api",
          label: "tests/api",
          inferred_responsibility: "Test coverage",
          file_count: 1,
          evidence_refs: ["tests/api/routes.test.ts"],
          uncertainty: "low"
        }
      ]
    });

    const result = analyzeRepositoryRisk({
      repo_profile: repoProfile,
      architecture_summary: architectureSummary
    });

    expect(result.providers).toEqual([
      {
        provider_id: "complexity",
        label: "Complexity",
        description: "Scores subsystem size from bounded file-count evidence."
      },
      {
        provider_id: "coverage",
        label: "Coverage",
        description: "Scores likely test coverage gaps from sampled repository evidence."
      },
      {
        provider_id: "architecture_risk",
        label: "Architecture Risk",
        description: "Scores architectural uncertainty from bounded subsystem inference confidence."
      }
    ]);

    expect(result.hotspots).toEqual([
      {
        subsystem_id: "src/cli",
        label: "src/cli",
        score: 61,
        level: "medium",
        evidence_refs: ["src/cli/format.ts", "src/cli/main.ts"],
        provider_scores: [
          {
            provider_id: "complexity",
            score: 40,
            rationale: "2 sampled files indicate moderate subsystem size.",
            evidence_refs: ["src/cli/format.ts", "src/cli/main.ts"]
          },
          {
            provider_id: "coverage",
            score: 85,
            rationale: "No matching test evidence was found for this subsystem.",
            evidence_refs: []
          },
          {
            provider_id: "architecture_risk",
            score: 55,
            rationale: "Subsystem inference still carries medium architectural uncertainty.",
            evidence_refs: ["src/cli/format.ts", "src/cli/main.ts"]
          }
        ]
      },
      {
        subsystem_id: "src/api",
        label: "src/api",
        score: 35,
        level: "low",
        evidence_refs: [
          "src/api/controller.ts",
          "src/api/routes.ts",
          "src/api/service.ts",
          "tests/api/routes.test.ts"
        ],
        provider_scores: [
          {
            provider_id: "complexity",
            score: 40,
            rationale: "3 sampled files indicate moderate subsystem size.",
            evidence_refs: [
              "src/api/controller.ts",
              "src/api/routes.ts",
              "src/api/service.ts"
            ]
          },
          {
            provider_id: "coverage",
            score: 40,
            rationale: "Limited matching test evidence was found for this subsystem.",
            evidence_refs: ["tests/api/routes.test.ts"]
          },
          {
            provider_id: "architecture_risk",
            score: 15,
            rationale: "Subsystem inference is backed by multiple evidence refs with low uncertainty.",
            evidence_refs: [
              "src/api/controller.ts",
              "src/api/routes.ts",
              "src/api/service.ts"
            ]
          }
        ]
      }
    ]);
  });
});

function createRepoProfile(input: { sampled_files: string[] }): RepoProfileArtifact {
  return {
    kind: "repo_profile",
    metadata: {
      artifact_id: "repo_profile",
      artifact_version: "v1",
      created_timestamp: "2026-03-16T00:00:00.000Z",
      generator: "operation.profileRepository",
      source_refs: [],
      checksum: "0".repeat(64)
    },
    project_mode: "existing-repo",
    repository_root: "/workspace/specforge",
    scan: {
      max_files: 200,
      scanned_file_count: input.sampled_files.length,
      truncated: false,
      ignored_directories: [".git", ".specforge"]
    },
    evidence: {
      top_level_entries: ["src", "tests"],
      sampled_files: input.sampled_files,
      extension_counts: [
        { extension: ".test.ts", count: 1 },
        { extension: ".ts", count: input.sampled_files.length - 1 }
      ],
      detected_manifests: ["package.json", "tsconfig.json"],
      detected_tooling: ["node", "typescript"]
    }
  };
}

function createArchitectureSummary(input: {
  subsystems: ArchitectureSummaryArtifact["subsystems"];
}): ArchitectureSummaryArtifact {
  return {
    kind: "architecture_summary",
    metadata: {
      artifact_id: "architecture_summary",
      artifact_version: "v1",
      created_timestamp: "2026-03-16T00:00:00.000Z",
      generator: "operation.mapArchitectureFromRepo",
      source_refs: [{ artifact_id: "repo_profile", artifact_version: "v1" }],
      checksum: "1".repeat(64)
    },
    project_mode: "existing-repo",
    repository_root: "/workspace/specforge",
    subsystems: input.subsystems,
    summary_markdown: "# Architecture Summary"
  };
}
