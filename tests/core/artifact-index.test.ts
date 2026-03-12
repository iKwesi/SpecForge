import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  ArtifactIndexError,
  buildArtifactVersionIndex,
  createArtifactIndex,
  readArtifactIndex,
  registerArtifactVersion,
  resolveArtifactVersion,
  writeArtifactIndex
} from "../../src/core/artifacts/index.js";

describe("artifact index deterministic registration", () => {
  it("maintains deterministic ordering of entries and versions", () => {
    const base = createArtifactIndex();

    const withVersions = registerArtifactVersion(
      registerArtifactVersion(
        registerArtifactVersion(base, {
          artifact_id: "prd.main",
          artifact_version: "v2"
        }),
        {
          artifact_id: "idea_brief",
          artifact_version: "v1"
        }
      ),
      {
        artifact_id: "prd.main",
        artifact_version: "v1"
      }
    );

    expect(withVersions.entries).toEqual([
      {
        artifact_id: "idea_brief",
        versions: ["v1"],
        latest_version: "v1"
      },
      {
        artifact_id: "prd.main",
        versions: ["v1", "v2"],
        latest_version: "v2"
      }
    ]);
  });

  it("deduplicates existing versions", () => {
    const first = registerArtifactVersion(createArtifactIndex(), {
      artifact_id: "spec.main",
      artifact_version: "v1"
    });

    const second = registerArtifactVersion(first, {
      artifact_id: "spec.main",
      artifact_version: "v1"
    });

    expect(second.entries).toEqual([
      {
        artifact_id: "spec.main",
        versions: ["v1"],
        latest_version: "v1"
      }
    ]);
  });
});

describe("artifact index lookup resolution", () => {
  it("resolves latest by default and explicit versions when requested", () => {
    const index = registerArtifactVersion(
      registerArtifactVersion(createArtifactIndex(), {
        artifact_id: "prd.main",
        artifact_version: "v1"
      }),
      {
        artifact_id: "prd.main",
        artifact_version: "v3"
      }
    );

    expect(resolveArtifactVersion(index, { artifact_id: "prd.main" })).toBe("v3");
    expect(resolveArtifactVersion(index, { artifact_id: "prd.main", requested_version: "v1" })).toBe(
      "v1"
    );
    expect(resolveArtifactVersion(index, { artifact_id: "prd.main", requested_version: "v2" })).toBe(
      undefined
    );
    expect(resolveArtifactVersion(index, { artifact_id: "unknown.main" })).toBe(undefined);
  });

  it("produces latest-version lookup map for downstream validators", () => {
    const index = registerArtifactVersion(
      registerArtifactVersion(createArtifactIndex(), {
        artifact_id: "idea_brief",
        artifact_version: "v2"
      }),
      {
        artifact_id: "prd.main",
        artifact_version: "v4"
      }
    );

    expect(buildArtifactVersionIndex(index)).toEqual({
      idea_brief: "v2",
      "prd.main": "v4"
    });
  });
});

describe("artifact index read/write", () => {
  it("writes and reads a canonical deterministic index file", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "specforge-artifact-index-"));
    const filePath = join(tmp, "artifact-index.json");

    const index = registerArtifactVersion(
      registerArtifactVersion(createArtifactIndex(), {
        artifact_id: "spec.main",
        artifact_version: "v2"
      }),
      {
        artifact_id: "spec.main",
        artifact_version: "v1"
      }
    );

    await writeArtifactIndex(filePath, index);

    const raw = await readFile(filePath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);

    const parsed = await readArtifactIndex(filePath);
    expect(parsed).toEqual({
      schema_version: "v1",
      entries: [
        {
          artifact_id: "spec.main",
          versions: ["v1", "v2"],
          latest_version: "v2"
        }
      ]
    });
  });

  it("returns empty index for missing file path", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "specforge-artifact-index-"));
    const filePath = join(tmp, "missing.json");

    const result = await readArtifactIndex(filePath);
    expect(result).toEqual(createArtifactIndex());
  });

  it("throws typed invalid_index error for malformed file content", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "specforge-artifact-index-"));
    const filePath = join(tmp, "artifact-index.json");
    await writeFile(filePath, "{\"schema_version\":\"v1\",\"entries\":\"bad\"}\n", "utf8");

    await expect(readArtifactIndex(filePath)).rejects.toEqual(
      expect.objectContaining<Partial<ArtifactIndexError>>({ code: "invalid_index" })
    );
  });
});
