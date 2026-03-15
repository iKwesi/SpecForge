import { describe, expect, it } from "vitest";

import {
  createArtifactIndex,
  registerArtifactVersion
} from "../../src/core/artifacts/index.js";
import {
  diagnoseContractDrift,
  formatContractDriftReport,
  recordReplayableRun,
  ReplayableRunError
} from "../../src/core/diagnostics/replayableRun.js";

describe("replayable run diagnostics", () => {
  it("records a replayable run with deterministic topological replay order", () => {
    const record = recordReplayableRun({
      run_id: "run-001",
      artifacts: [
        createArtifact({
          artifact_id: "context_pack",
          artifact_version: "v1",
          generator: "operation.buildContextPack",
          source_refs: [{ artifact_id: "spec.main", artifact_version: "v1" }]
        }),
        createArtifact({
          artifact_id: "spec.main",
          artifact_version: "v1",
          generator: "operation.generateSpecPack",
          source_refs: [{ artifact_id: "prd.json", artifact_version: "v1" }]
        }),
        createArtifact({
          artifact_id: "idea_brief",
          artifact_version: "v1",
          generator: "operation.ideaInterview"
        }),
        createArtifact({
          artifact_id: "prd.json",
          artifact_version: "v1",
          generator: "operation.generatePRD",
          source_refs: [{ artifact_id: "idea_brief", artifact_version: "v1" }]
        })
      ]
    });

    expect(record.replayable).toBe(true);
    expect(record.missing_source_refs).toEqual([]);
    expect(record.replay_order.map((step) => `${step.artifact_id}@${step.artifact_version}`)).toEqual([
      "idea_brief@v1",
      "prd.json@v1",
      "spec.main@v1",
      "context_pack@v1"
    ]);
  });

  it("marks a run as non-replayable when a required source artifact is missing", () => {
    const record = recordReplayableRun({
      run_id: "run-002",
      artifacts: [
        createArtifact({
          artifact_id: "prd.json",
          artifact_version: "v1",
          generator: "operation.generatePRD",
          source_refs: [{ artifact_id: "idea_brief", artifact_version: "v1" }]
        })
      ]
    });

    expect(record.replayable).toBe(false);
    expect(record.missing_source_refs).toEqual([
      {
        artifact_id: "idea_brief",
        artifact_version: "v1"
      }
    ]);
  });

  it("diagnoses stale and missing contract references against the current artifact index", () => {
    const record = recordReplayableRun({
      run_id: "run-003",
      artifacts: [
        createArtifact({
          artifact_id: "spec.main",
          artifact_version: "v1",
          generator: "operation.generateSpecPack"
        }),
        createArtifact({
          artifact_id: "schemas/core.schema.json",
          artifact_version: "v1",
          generator: "operation.generateSpecPack"
        }),
        createArtifact({
          artifact_id: "context_pack",
          artifact_version: "v1",
          generator: "operation.buildContextPack",
          source_refs: [
            { artifact_id: "spec.main", artifact_version: "v1" },
            { artifact_id: "schemas/core.schema.json", artifact_version: "v1" }
          ]
        }),
        createArtifact({
          artifact_id: "task_result",
          artifact_version: "v1",
          generator: "operation.devTDDTask",
          source_refs: [{ artifact_id: "schemas/core.schema.json", artifact_version: "v2" }]
        })
      ]
    });

    let artifactIndex = createArtifactIndex();
    artifactIndex = registerArtifactVersion(artifactIndex, {
      artifact_id: "spec.main",
      artifact_version: "v1"
    });
    artifactIndex = registerArtifactVersion(artifactIndex, {
      artifact_id: "spec.main",
      artifact_version: "v2"
    });
    artifactIndex = registerArtifactVersion(artifactIndex, {
      artifact_id: "schemas/core.schema.json",
      artifact_version: "v1"
    });

    const drift = diagnoseContractDrift({
      record,
      artifact_index: artifactIndex,
      contract_artifact_ids: ["schemas/core.schema.json", "spec.main"]
    });

    expect(drift.status).toBe("drift_detected");
    expect(drift.impacted_artifacts).toEqual(["context_pack@v1", "task_result@v1"]);
    expect(drift.issues).toEqual([
      {
        consumer_artifact_id: "context_pack",
        consumer_artifact_version: "v1",
        contract_artifact_id: "spec.main",
        referenced_version: "v1",
        latest_version: "v2",
        issue_code: "stale_contract_version"
      },
      {
        consumer_artifact_id: "task_result",
        consumer_artifact_version: "v1",
        contract_artifact_id: "schemas/core.schema.json",
        referenced_version: "v2",
        issue_code: "missing_referenced_contract_version"
      }
    ]);

    expect(formatContractDriftReport(drift)).toContain(
      "context_pack@v1 depends on stale contract spec.main@v1 (latest v2)."
    );
    expect(formatContractDriftReport(drift)).toContain(
      "task_result@v1 depends on missing contract version schemas/core.schema.json@v2."
    );
  });

  it("fails with invalid_record when serialized artifacts contain non-object entries", () => {
    expect(() =>
      diagnoseContractDrift({
        record: {
          schema_version: "v1",
          run_id: "run-004",
          replayable: true,
          missing_source_refs: [],
          artifacts: [null as never],
          replay_order: []
        },
        artifact_index: createArtifactIndex(),
        contract_artifact_ids: ["spec.main"]
      })
    ).toThrowError(
      expect.objectContaining<Partial<ReplayableRunError>>({
        code: "invalid_record",
        message: "replayable run record artifacts[0] must be an object."
      })
    );
  });

  it("fails with invalid_record when serialized replay steps contain invalid versions", () => {
    expect(() =>
      diagnoseContractDrift({
        record: {
          schema_version: "v1",
          run_id: "run-005",
          replayable: true,
          missing_source_refs: [],
          artifacts: [
            {
              path: "/tmp/spec.main-v1.json",
              artifact_id: "spec.main",
              artifact_version: "v1",
              generator: "operation.generateSpecPack",
              created_timestamp: "2026-03-15T00:00:00.000Z",
              checksum: "spec.main-v1-checksum",
              source_refs: []
            }
          ],
          replay_order: [
            {
              artifact_id: "spec.main",
              artifact_version: "bad-version",
              generator: "operation.generateSpecPack",
              path: "/tmp/spec.main-v1.json",
              source_refs: []
            }
          ]
        },
        artifact_index: createArtifactIndex(),
        contract_artifact_ids: ["spec.main"]
      })
    ).toThrowError(
      expect.objectContaining<Partial<ReplayableRunError>>({
        code: "invalid_record",
        message: "artifact_version must be in v<number> format: record.replay_order"
      })
    );
  });

  it("fails with invalid_record when replay step source_refs is not an array", () => {
    expect(() =>
      diagnoseContractDrift({
        record: {
          schema_version: "v1",
          run_id: "run-006",
          replayable: true,
          missing_source_refs: [],
          artifacts: [
            {
              path: "/tmp/spec.main-v1.json",
              artifact_id: "spec.main",
              artifact_version: "v1",
              generator: "operation.generateSpecPack",
              created_timestamp: "2026-03-15T00:00:00.000Z",
              checksum: "spec.main-v1-checksum",
              source_refs: []
            }
          ],
          replay_order: [
            {
              artifact_id: "spec.main",
              artifact_version: "v1",
              generator: "operation.generateSpecPack",
              path: "/tmp/spec.main-v1.json",
              source_refs: "not-an-array"
            }
          ]
        },
        artifact_index: createArtifactIndex(),
        contract_artifact_ids: ["spec.main"]
      })
    ).toThrowError(
      expect.objectContaining<Partial<ReplayableRunError>>({
        code: "invalid_record",
        message: "record.replay_order source_refs must be an array when provided."
      })
    );
  });

  it("fails with invalid_record when replayable has the wrong type", () => {
    expect(() =>
      diagnoseContractDrift({
        record: {
          schema_version: "v1",
          run_id: "run-007",
          replayable: "yes",
          missing_source_refs: [],
          artifacts: [],
          replay_order: []
        },
        artifact_index: createArtifactIndex(),
        contract_artifact_ids: ["spec.main"]
      })
    ).toThrowError(
      expect.objectContaining<Partial<ReplayableRunError>>({
        code: "invalid_record",
        message: "replayable must be a boolean."
      })
    );
  });

  it("fails with invalid_record when missing_source_refs has the wrong type", () => {
    expect(() =>
      diagnoseContractDrift({
        record: {
          schema_version: "v1",
          run_id: "run-008",
          replayable: true,
          missing_source_refs: "not-an-array",
          artifacts: [],
          replay_order: []
        },
        artifact_index: createArtifactIndex(),
        contract_artifact_ids: ["spec.main"]
      })
    ).toThrowError(
      expect.objectContaining<Partial<ReplayableRunError>>({
        code: "invalid_record",
        message: "replayable run record missing_source_refs must be an array."
      })
    );
  });
});

function createArtifact(input: {
  artifact_id: string;
  artifact_version: `v${number}`;
  generator: string;
  source_refs?: Array<{ artifact_id: string; artifact_version: `v${number}` }>;
}) {
  return {
    path: `/tmp/${input.artifact_id.replaceAll("/", "_")}-${input.artifact_version}.json`,
    value: {
      kind: input.artifact_id,
      metadata: {
        artifact_id: input.artifact_id,
        artifact_version: input.artifact_version,
        created_timestamp: "2026-03-15T00:00:00.000Z",
        generator: input.generator,
        source_refs: input.source_refs ?? [],
        checksum: `${input.artifact_id}-${input.artifact_version}-checksum`
      }
    }
  };
}
