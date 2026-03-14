export type DryRunChangeStatus = "planned" | "blocked";

export type DryRunChangeKind =
  | "artifact_write"
  | "file_write"
  | "task_execution"
  | "branch_create"
  | "workspace_prepare"
  | "workspace_remove"
  | "gate_blocked";

export interface DryRunChange {
  status: DryRunChangeStatus;
  kind: DryRunChangeKind;
  target: string;
  detail: string;
}

export interface DryRunReport {
  enabled: true;
  changes: DryRunChange[];
}

/**
 * Dry-run reports stay explicit and ordered so callers can explain exactly which
 * mutations were suppressed, without inferring intent from operation-specific fields.
 */
export function createDryRunReport(changes: DryRunChange[]): DryRunReport {
  return {
    enabled: true,
    changes: [...changes]
  };
}

export function mergeDryRunReports(
  ...reports: Array<DryRunReport | undefined>
): DryRunReport | undefined {
  const changes = reports.flatMap((report) => report?.changes ?? []);
  return changes.length > 0 ? createDryRunReport(changes) : undefined;
}
