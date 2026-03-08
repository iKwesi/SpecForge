export const ARTIFACT_KINDS = [
  "idea_brief",
  "prd",
  "spec",
  "validation_report"
] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export interface ArtifactOwnershipContract {
  artifact_kind: ArtifactKind;
  owner_skill: string;
}

export const ARTIFACT_OWNERSHIP_REGISTRY: Record<ArtifactKind, ArtifactOwnershipContract> = {
  idea_brief: {
    artifact_kind: "idea_brief",
    owner_skill: "skill.ideaInterview"
  },
  prd: {
    artifact_kind: "prd",
    owner_skill: "skill.generatePRD"
  },
  spec: {
    artifact_kind: "spec",
    owner_skill: "skill.generateSpecPack"
  },
  validation_report: {
    artifact_kind: "validation_report",
    owner_skill: "skill.validateSpecPack"
  }
};

export function inferArtifactKindFromId(artifactId: string): ArtifactKind | undefined {
  if (artifactId === "idea_brief") {
    return "idea_brief";
  }

  if (artifactId.startsWith("prd.")) {
    return "prd";
  }

  if (artifactId.startsWith("spec.")) {
    return "spec";
  }

  if (artifactId.startsWith("validation_report.")) {
    return "validation_report";
  }

  return undefined;
}

export function isOwnedArtifactKind(kind: string): kind is ArtifactKind {
  return ARTIFACT_KINDS.includes(kind as ArtifactKind);
}

