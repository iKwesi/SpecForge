export const PROJECT_MODES = [
  "greenfield",
  "existing-repo",
  "contribution",
  "feature-proposal"
] as const;

export type ProjectMode = (typeof PROJECT_MODES)[number];

export const ARTIFACT_GATES = [
  "proposal_approval",
  "spec_approval",
  "execution_start",
  "merge_approval"
] as const;

export type ArtifactGate = (typeof ARTIFACT_GATES)[number];

