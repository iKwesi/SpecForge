import { describe, expect, it } from "vitest";

import {
  BUILT_IN_SKILL_PROVIDER_ID,
  createBootstrappedSkillRegistry,
  getBuiltInSkillRegistrations
} from "../../src/core/skills/builtins.js";

describe("built-in skill bootstrap", () => {
  it("registers the built-in provider and skill set automatically", () => {
    const registry = createBootstrappedSkillRegistry();

    expect(registry.listProviders()).toEqual([
      {
        provider_id: BUILT_IN_SKILL_PROVIDER_ID,
        display_name: "SpecForge Built-ins",
        source_type: "built-in",
        publisher: "SpecForge",
        version: "1.0.0"
      }
    ]);

    expect(registry.listSkills().map((skill) => skill.skill_id)).toEqual([
      "builtin.idea-triage",
      "builtin.spec-drafter"
    ]);
    expect(registry.listSkills()).toEqual(
      getBuiltInSkillRegistrations().map((skill) =>
        expect.objectContaining({
          skill_id: skill.skill_id,
          provider_id: BUILT_IN_SKILL_PROVIDER_ID
        })
      )
    );
  });

  it("allows external skills to extend the built-in catalog", () => {
    const registry = createBootstrappedSkillRegistry({
      providers: [
        {
          provider_id: "vendor.delta",
          display_name: "Delta Skills",
          source_type: "external"
        }
      ],
      skills: [
        {
          skill_id: "vendor.delta.review",
          display_name: "Delta Review",
          version: "1.0.0",
          provider_id: "vendor.delta",
          capability_contract: {
            supported_domains: ["backend"],
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
    });

    expect(registry.listProviders().map((provider) => provider.provider_id)).toEqual([
      BUILT_IN_SKILL_PROVIDER_ID,
      "vendor.delta"
    ]);
    expect(registry.listSkills().map((skill) => skill.skill_id)).toEqual([
      "builtin.idea-triage",
      "builtin.spec-drafter",
      "vendor.delta.review"
    ]);
  });

  it("lets external skills override built-ins by reusing the built-in skill id", () => {
    const registry = createBootstrappedSkillRegistry({
      providers: [
        {
          provider_id: "vendor.delta",
          display_name: "Delta Skills",
          source_type: "external"
        }
      ],
      skills: [
        {
          skill_id: "builtin.spec-drafter",
          display_name: "Delta Spec Drafter Override",
          version: "2.0.0",
          provider_id: "vendor.delta",
          capability_contract: {
            supported_domains: ["planning"],
            supported_task_types: ["drafting"],
            input_contract: "specforge.idea_brief.v1",
            output_contract: "specforge.prd.v1"
          },
          trust: {
            trust_level: "verified",
            verification_status: "verified",
            requires_approval: true
          }
        }
      ]
    });

    expect(registry.listSkills().map((skill) => skill.skill_id)).toEqual([
      "builtin.idea-triage",
      "builtin.spec-drafter"
    ]);
    expect(registry.getSkill("builtin.spec-drafter")).toEqual(
      expect.objectContaining({
        display_name: "Delta Spec Drafter Override",
        provider_id: "vendor.delta",
        provider: expect.objectContaining({
          provider_id: "vendor.delta",
          source_type: "external"
        }),
        trust: expect.objectContaining({
          requires_approval: true
        })
      })
    );
  });
});
