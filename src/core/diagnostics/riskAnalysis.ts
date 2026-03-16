import type { ArchitectureSummaryArtifact, ArchitectureSubsystem } from "../operations/mapArchitectureFromRepo.js";
import type { RepoProfileArtifact } from "../operations/profileRepository.js";

export type RiskAnalysisErrorCode = "invalid_input";
export type RiskProviderId = "complexity" | "coverage" | "architecture_risk";
export type RiskLevel = "low" | "medium" | "high";

export class RiskAnalysisError extends Error {
  readonly code: RiskAnalysisErrorCode;
  readonly details?: unknown;

  constructor(code: RiskAnalysisErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "RiskAnalysisError";
    this.code = code;
    this.details = details;
  }
}

export interface RiskProviderDefinition {
  provider_id: RiskProviderId;
  label: string;
  description: string;
}

export interface RiskProviderScore {
  provider_id: RiskProviderId;
  score: number;
  rationale: string;
  evidence_refs: string[];
}

export interface RiskHotspot {
  subsystem_id: string;
  label: string;
  score: number;
  level: RiskLevel;
  evidence_refs: string[];
  provider_scores: RiskProviderScore[];
}

export interface RepositoryRiskAnalysis {
  providers: RiskProviderDefinition[];
  hotspots: RiskHotspot[];
}

export interface AnalyzeRepositoryRiskInput {
  repo_profile?: RepoProfileArtifact;
  architecture_summary?: ArchitectureSummaryArtifact;
}

const PROVIDERS: RiskProviderDefinition[] = [
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
];

/**
 * Score bounded repository evidence into deterministic hotspots. The heuristic
 * intentionally stays simple: subsystem size, likely test coverage, and
 * architecture uncertainty are weighted into one sortable score.
 */
export function analyzeRepositoryRisk(input: AnalyzeRepositoryRiskInput): RepositoryRiskAnalysis {
  const repoProfile = ensureRepoProfile(input.repo_profile);
  const architectureSummary = ensureArchitectureSummary(input.architecture_summary);

  if (repoProfile.repository_root !== architectureSummary.repository_root) {
    throw new RiskAnalysisError(
      "invalid_input",
      "repo_profile and architecture_summary must share the same repository_root."
    );
  }

  const sampledFiles = [...repoProfile.evidence.sampled_files];
  const hotspots = architectureSummary.subsystems
    .filter((subsystem) => !isTestOnlySubsystem(subsystem))
    .map((subsystem) => buildHotspot(subsystem, sampledFiles))
    .sort(compareHotspots);

  return {
    providers: PROVIDERS.map((provider) => ({ ...provider })),
    hotspots
  };
}

function ensureRepoProfile(repoProfile?: RepoProfileArtifact): RepoProfileArtifact {
  if (!repoProfile || repoProfile.kind !== "repo_profile") {
    throw new RiskAnalysisError("invalid_input", "repo_profile must be a repo_profile artifact.");
  }

  return repoProfile;
}

function ensureArchitectureSummary(
  architectureSummary?: ArchitectureSummaryArtifact
): ArchitectureSummaryArtifact {
  if (!architectureSummary || architectureSummary.kind !== "architecture_summary") {
    throw new RiskAnalysisError(
      "invalid_input",
      "architecture_summary must be an architecture_summary artifact."
    );
  }

  return architectureSummary;
}

function isTestOnlySubsystem(subsystem: ArchitectureSubsystem): boolean {
  return subsystem.id.startsWith("tests/") || subsystem.inferred_responsibility === "Test coverage";
}

function buildHotspot(subsystem: ArchitectureSubsystem, sampledFiles: string[]): RiskHotspot {
  const matchingTests = findMatchingTestEvidence(subsystem, sampledFiles);
  const providerScores: [RiskProviderScore, RiskProviderScore, RiskProviderScore] = [
    buildComplexityScore(subsystem),
    buildCoverageScore(subsystem, matchingTests),
    buildArchitectureRiskScore(subsystem)
  ];
  const [complexityScore, coverageScore, architectureRiskScore] = providerScores;
  const evidenceRefs = sortUniqueStrings(
    providerScores.flatMap((providerScore) => providerScore.evidence_refs)
  );
  const score = Math.round(
    complexityScore.score * 0.4 + coverageScore.score * 0.4 + architectureRiskScore.score * 0.2
  );

  return {
    subsystem_id: subsystem.id,
    label: subsystem.label,
    score,
    level: toRiskLevel(score),
    evidence_refs: evidenceRefs,
    provider_scores: providerScores
  };
}

function buildComplexityScore(subsystem: ArchitectureSubsystem): RiskProviderScore {
  const score =
    subsystem.file_count >= 6 ? 80 :
    subsystem.file_count >= 4 ? 60 :
    subsystem.file_count >= 2 ? 40 :
    20;

  let descriptor = "small";
  if (score === 40) {
    descriptor = "moderate";
  } else if (score === 60) {
    descriptor = "large";
  } else if (score === 80) {
    descriptor = "very large";
  }

  return {
    provider_id: "complexity",
    score,
    rationale: `${subsystem.file_count} sampled files indicate ${descriptor} subsystem size.`,
    evidence_refs: [...subsystem.evidence_refs]
  };
}

function buildCoverageScore(
  subsystem: ArchitectureSubsystem,
  matchingTests: string[]
): RiskProviderScore {
  if (matchingTests.length === 0) {
    return {
      provider_id: "coverage",
      score: 85,
      rationale: "No matching test evidence was found for this subsystem.",
      evidence_refs: []
    };
  }

  if (matchingTests.length >= Math.max(2, Math.ceil(subsystem.file_count / 2))) {
    return {
      provider_id: "coverage",
      score: 15,
      rationale: "Matching test evidence covers this subsystem with bounded confidence.",
      evidence_refs: [...matchingTests]
    };
  }

  return {
    provider_id: "coverage",
    score: 40,
    rationale: "Limited matching test evidence was found for this subsystem.",
    evidence_refs: [...matchingTests]
  };
}

function buildArchitectureRiskScore(subsystem: ArchitectureSubsystem): RiskProviderScore {
  if (subsystem.uncertainty === "medium") {
    return {
      provider_id: "architecture_risk",
      score: 55,
      rationale: "Subsystem inference still carries medium architectural uncertainty.",
      evidence_refs: [...subsystem.evidence_refs]
    };
  }

  return {
    provider_id: "architecture_risk",
    score: 15,
    rationale: "Subsystem inference is backed by multiple evidence refs with low uncertainty.",
    evidence_refs: [...subsystem.evidence_refs]
  };
}

function findMatchingTestEvidence(subsystem: ArchitectureSubsystem, sampledFiles: string[]): string[] {
  const leafSegment = subsystem.id.split("/").filter((segment) => segment.length > 0).pop();
  const sourceBaseNames = new Set(subsystem.evidence_refs.map((path) => normalizePathBaseName(path)));

  return sortUniqueStrings(
    sampledFiles.filter((path) => {
      if (!isTestPath(path)) {
        return false;
      }

      const pathSegments = path.split("/").filter((segment) => segment.length > 0);
      if (leafSegment && pathSegments.includes(leafSegment)) {
        return true;
      }

      return sourceBaseNames.has(normalizePathBaseName(path));
    })
  );
}

function isTestPath(path: string): boolean {
  return (
    path.includes("/tests/") ||
    path.startsWith("tests/") ||
    path.includes("__tests__") ||
    /\.test\.[^/]+$/i.test(path) ||
    /\.spec\.[^/]+$/i.test(path)
  );
}

function normalizePathBaseName(path: string): string {
  const fileName = path.split("/").pop() ?? path;
  return fileName
    .replace(/\.[^.]+$/u, "")
    .replace(/(?:\.test|\.spec)$/u, "")
    .trim()
    .toLowerCase();
}

function toRiskLevel(score: number): RiskLevel {
  if (score >= 70) {
    return "high";
  }

  if (score >= 40) {
    return "medium";
  }

  return "low";
}

function compareHotspots(left: RiskHotspot, right: RiskHotspot): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }

  return left.subsystem_id.localeCompare(right.subsystem_id);
}

function sortUniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
