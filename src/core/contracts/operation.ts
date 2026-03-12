export interface OperationContract<TInputs, TOutputs> {
  name: string;
  version: string;
  purpose: string;
  inputs_schema: TInputs;
  outputs_schema: TOutputs;
  side_effects: string[];
  invariants: string[];
  idempotency_expectations: string[];
  failure_modes: string[];
  observability_fields: string[];
}

