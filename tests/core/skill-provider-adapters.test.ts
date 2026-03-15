import { describe, expect, it } from "vitest";

import { createBootstrappedSkillRegistry } from "../../src/core/skills/builtins.js";
import { recommendSkills } from "../../src/core/skills/selectionPolicy.js";
import {
  ExternalSkillPackAdapterError,
  createPrototypePostgresSkillPack,
  loadExternalSkillPack,
  registerExternalSkillPack
} from "../../src/core/skills/providerAdapters.js";

describe("external skill pack provider adapters", () => {
  it("loads a prototype external skill pack through an explicit adapter and registers it in the registry", async () => {
    const registry = createBootstrappedSkillRegistry();

    const adapter = {
      adapter_id: "prototype.postgres-pack",
      async load() {
        return createPrototypePostgresSkillPack();
      }
    };

    const loaded = await loadExternalSkillPack(adapter);
    registerExternalSkillPack(registry, loaded);

    expect(loaded.provider.provider_id).toBe("pack.postgres");
    expect(registry.getProvider("pack.postgres")).toEqual(
      expect.objectContaining({
        provider_id: "pack.postgres",
        source_type: "external",
        publisher: "SpecForge Prototype Packs"
      })
    );
    expect(registry.listSkills().map((skill) => skill.skill_id)).toEqual([
      "builtin.idea-triage",
      "builtin.spec-drafter",
      "pack.postgres.query-review",
      "pack.postgres.schema-risk"
    ]);
  });

  it("keeps external pack metadata compatible with registry trust/provider concepts and selection policy", () => {
    const registry = createBootstrappedSkillRegistry();

    registerExternalSkillPack(registry, createPrototypePostgresSkillPack());

    const recommendation = recommendSkills({
      registry,
      domain: "database",
      task_type: "review",
      input_contract: "specforge.context_pack.v1",
      output_contract: "specforge.skill_result.v1",
      policy: {
        minimum_trust_level: "verified",
        require_approval_on_first_use: true
      }
    });

    expect(recommendation.recommendations).toEqual([
      expect.objectContaining({
        skill_id: "pack.postgres.query-review",
        provider_id: "pack.postgres",
        approval_required: true,
        reason_codes: expect.arrayContaining(["first_use_requires_approval"])
      })
    ]);
    expect(recommendation.rejected_skills).toEqual(
      expect.arrayContaining([
        {
          skill_id: "pack.postgres.schema-risk",
          reason_codes: ["task_type_not_supported"]
        }
      ])
    );
  });

  it("wraps unexpected adapter load failures in a typed adapter error", async () => {
    const rootCause = new Error("network timeout");

    await expect(
      loadExternalSkillPack({
        adapter_id: "prototype.failing-pack",
        async load() {
          throw rootCause;
        }
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<ExternalSkillPackAdapterError>>({
        code: "invalid_adapter",
        message: 'adapter.load() failed for adapter_id "prototype.failing-pack".',
        details: {
          adapter_id: "prototype.failing-pack",
          cause: rootCause
        }
      })
    );
  });

  it("rejects external packs that reuse a skill_id within the same pack", async () => {
    await expect(
      loadExternalSkillPack({
        adapter_id: "prototype.duplicate-skill-pack",
        async load() {
          return {
            pack_id: "prototype.duplicate-skill-pack",
            provider: {
              provider_id: "pack.duplicate",
              display_name: "Duplicate Skill Pack",
              source_type: "external"
            },
            skills: [
              {
                skill_id: "pack.duplicate.analysis",
                display_name: "Duplicate Analysis",
                version: "0.1.0",
                provider_id: "pack.duplicate",
                capability_contract: {
                  supported_domains: ["planning"],
                  supported_task_types: ["analysis"],
                  input_contract: "specforge.context_pack.v1",
                  output_contract: "specforge.skill_result.v1"
                },
                trust: {
                  trust_level: "verified",
                  verification_status: "verified",
                  requires_approval: false
                }
              },
              {
                skill_id: "pack.duplicate.analysis",
                display_name: "Duplicate Analysis Copy",
                version: "0.1.0",
                provider_id: "pack.duplicate",
                capability_contract: {
                  supported_domains: ["planning"],
                  supported_task_types: ["review"],
                  input_contract: "specforge.context_pack.v1",
                  output_contract: "specforge.skill_result.v1"
                },
                trust: {
                  trust_level: "verified",
                  verification_status: "verified",
                  requires_approval: false
                }
              }
            ]
          };
        }
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<ExternalSkillPackAdapterError>>({
        code: "invalid_skill_pack",
        message:
          'duplicate skill_id "pack.duplicate.analysis" in external skill pack "prototype.duplicate-skill-pack".'
      })
    );
  });

  it("fails fast when an external pack reuses an incompatible provider identity", () => {
    const registry = createBootstrappedSkillRegistry();

    expect(() =>
      registerExternalSkillPack(registry, {
        pack_id: "pack.builtin-collision",
        provider: {
          provider_id: "builtin",
          display_name: "External Builtin Collision",
          source_type: "external",
          publisher: "Third Party Pack",
          version: "0.1.0"
        },
        skills: [
          {
            skill_id: "pack.builtin-collision.analysis",
            display_name: "Builtin Collision Analysis",
            version: "0.1.0",
            provider_id: "builtin",
            capability_contract: {
              supported_domains: ["planning"],
              supported_task_types: ["analysis"],
              input_contract: "specforge.context_pack.v1",
              output_contract: "specforge.skill_result.v1"
            },
            trust: {
              trust_level: "verified",
              verification_status: "verified",
              requires_approval: true
            }
          }
        ]
      })
    ).toThrowError(
      expect.objectContaining<Partial<ExternalSkillPackAdapterError>>({
        code: "provider_mismatch"
      })
    );
  });

  it("fails with typed errors when the adapter or pack payload is invalid", async () => {
    await expect(
      loadExternalSkillPack({
        adapter_id: "bad.adapter",
        async load() {
          return null as never;
        }
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<ExternalSkillPackAdapterError>>({
        code: "invalid_skill_pack"
      })
    );

    expect(() =>
      registerExternalSkillPack(
        createBootstrappedSkillRegistry(),
        {
          pack_id: "pack.invalid",
          provider: {
            provider_id: "pack.invalid",
            display_name: "Invalid Pack",
            source_type: "built-in"
          },
          skills: []
        } as never
      )
    ).toThrowError(
      expect.objectContaining<Partial<ExternalSkillPackAdapterError>>({
        code: "invalid_skill_pack"
      })
    );
  });
});
