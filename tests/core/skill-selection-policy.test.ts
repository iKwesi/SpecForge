import { describe, expect, it } from "vitest";

import { createSkillRegistry } from "../../src/core/skills/registry.js";
import {
  SkillSelectionPolicyError,
  createDefaultSkillSelectionPolicy,
  recommendSkills
} from "../../src/core/skills/selectionPolicy.js";

describe("skill selection policy", () => {
  it("recommends skills deterministically by fit, trust, and provider preference", () => {
    const registry = createFixtureRegistry();

    const result = recommendSkills({
      registry,
      domain: "backend",
      task_type: "review",
      input_contract: "specforge.context_pack.v1",
      output_contract: "specforge.skill_result.v1"
    });

    expect(result.policy).toEqual(createDefaultSkillSelectionPolicy());
    expect(result.recommendations.map((skill) => skill.skill_id)).toEqual([
      "builtin.backend-review",
      "vendor.verified-review"
    ]);
    expect(result.recommendations[0]).toEqual(
      expect.objectContaining({
        skill_id: "builtin.backend-review",
        approval_required: false,
        reason_codes: expect.arrayContaining([
          "domain_supported",
          "task_type_supported",
          "contracts_compatible",
          "trust_preferred",
          "provider_preferred"
        ])
      })
    );
    expect(result.recommendations[1]).toEqual(
      expect.objectContaining({
        skill_id: "vendor.verified-review",
        approval_required: false,
        reason_codes: expect.arrayContaining([
          "domain_supported",
          "task_type_supported",
          "contracts_compatible"
        ])
      })
    );
  });

  it("records deterministic rejection reasons for domain, task, contract, and trust policy mismatches", () => {
    const registry = createFixtureRegistry();

    const result = recommendSkills({
      registry,
      domain: "backend",
      task_type: "review",
      input_contract: "specforge.context_pack.v1",
      output_contract: "specforge.skill_result.v1",
      policy: {
        minimum_trust_level: "verified"
      }
    });

    expect(result.rejected_skills).toEqual([
      {
        skill_id: "vendor.contract-mismatch",
        reason_codes: ["output_contract_incompatible"]
      },
      {
        skill_id: "vendor.frontend-review",
        reason_codes: ["domain_not_supported"]
      },
      {
        skill_id: "vendor.plan-drafter",
        reason_codes: [
          "task_type_not_supported",
          "input_contract_incompatible",
          "output_contract_incompatible"
        ]
      },
      {
        skill_id: "vendor.unverified-review",
        reason_codes: ["trust_below_policy"]
      }
    ]);
  });

  it("can require approval before first use for external skills while respecting prior approvals", () => {
    const registry = createFixtureRegistry();

    const firstUse = recommendSkills({
      registry,
      domain: "backend",
      task_type: "review",
      input_contract: "specforge.context_pack.v1",
      output_contract: "specforge.skill_result.v1",
      policy: {
        minimum_trust_level: "unverified",
        require_approval_on_first_use: true
      }
    });

    expect(firstUse.recommendations).toEqual([
      expect.objectContaining({
        skill_id: "builtin.backend-review",
        approval_required: false
      }),
      expect.objectContaining({
        skill_id: "vendor.verified-review",
        approval_required: true,
        reason_codes: expect.arrayContaining(["first_use_requires_approval"])
      }),
      expect.objectContaining({
        skill_id: "vendor.unverified-review",
        approval_required: true,
        reason_codes: expect.arrayContaining([
          "first_use_requires_approval",
          "provider_declares_approval_required"
        ])
      })
    ]);

    const afterApproval = recommendSkills({
      registry,
      domain: "backend",
      task_type: "review",
      input_contract: "specforge.context_pack.v1",
      output_contract: "specforge.skill_result.v1",
      policy: {
        minimum_trust_level: "unverified",
        require_approval_on_first_use: true
      },
      previously_approved_skill_ids: ["vendor.verified-review"]
    });

    expect(afterApproval.recommendations).toEqual([
      expect.objectContaining({
        skill_id: "builtin.backend-review",
        approval_required: false
      }),
      expect.objectContaining({
        skill_id: "vendor.verified-review",
        approval_required: false
      }),
      expect.objectContaining({
        skill_id: "vendor.unverified-review",
        approval_required: true
      })
    ]);
  });

  it("fails with typed errors when the request or policy shape is invalid", () => {
    const registry = createFixtureRegistry();

    expect(() =>
      recommendSkills({
        registry,
        domain: "",
        task_type: "review"
      })
    ).toThrowError(
      expect.objectContaining<Partial<SkillSelectionPolicyError>>({
        code: "invalid_request"
      })
    );

    expect(() =>
      recommendSkills({
        registry,
        domain: "backend",
        task_type: "review",
        policy: {
          minimum_trust_level: "bad" as never
        }
      })
    ).toThrowError(
      expect.objectContaining<Partial<SkillSelectionPolicyError>>({
        code: "invalid_policy"
      })
    );
  });
});

function createFixtureRegistry() {
  return createSkillRegistry({
    providers: [
      {
        provider_id: "builtin",
        display_name: "SpecForge Built-ins",
        source_type: "built-in"
      },
      {
        provider_id: "vendor.delta",
        display_name: "Delta Skills",
        source_type: "external"
      }
    ],
    skills: [
      {
        skill_id: "builtin.backend-review",
        display_name: "Built-in Backend Review",
        version: "1.0.0",
        provider_id: "builtin",
        capability_contract: {
          supported_domains: ["backend"],
          supported_task_types: ["review"],
          input_contract: "specforge.context_pack.v1",
          output_contract: "specforge.skill_result.v1"
        },
        trust: {
          trust_level: "trusted",
          verification_status: "verified",
          requires_approval: false
        }
      },
      {
        skill_id: "vendor.verified-review",
        display_name: "Verified External Review",
        version: "2.0.0",
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
      },
      {
        skill_id: "vendor.unverified-review",
        display_name: "Unverified External Review",
        version: "2.0.0",
        provider_id: "vendor.delta",
        capability_contract: {
          supported_domains: ["backend"],
          supported_task_types: ["review"],
          input_contract: "specforge.context_pack.v1",
          output_contract: "specforge.skill_result.v1"
        },
        trust: {
          trust_level: "unverified",
          verification_status: "self-attested",
          requires_approval: true
        }
      },
      {
        skill_id: "vendor.frontend-review",
        display_name: "Frontend Review",
        version: "1.0.0",
        provider_id: "vendor.delta",
        capability_contract: {
          supported_domains: ["frontend"],
          supported_task_types: ["review"],
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
        skill_id: "vendor.plan-drafter",
        display_name: "Plan Drafter",
        version: "1.0.0",
        provider_id: "vendor.delta",
        capability_contract: {
          supported_domains: ["backend"],
          supported_task_types: ["drafting"],
          input_contract: "specforge.idea_brief.v1",
          output_contract: "specforge.plan_hint.v1"
        },
        trust: {
          trust_level: "verified",
          verification_status: "verified",
          requires_approval: false
        }
      },
      {
        skill_id: "vendor.contract-mismatch",
        display_name: "Contract Mismatch",
        version: "1.0.0",
        provider_id: "vendor.delta",
        capability_contract: {
          supported_domains: ["backend"],
          supported_task_types: ["review"],
          input_contract: "specforge.context_pack.v1",
          output_contract: "specforge.other_output.v1"
        },
        trust: {
          trust_level: "verified",
          verification_status: "verified",
          requires_approval: false
        }
      }
    ]
  });
}
