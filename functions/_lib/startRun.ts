import { adminGraphQL } from './hasura';
import { runWorkflowLoop } from './runWorkflow';

const GET_ORG_QUOTA = `
  query GetOrgQuota($workflow_id: uuid!) {
    workflows_by_pk(id: $workflow_id) {
      org_id
      organization { quota_limit quota_used }
    }
  }
`;

const CHECK_ACTIVE_RUN = `
  query CheckActiveRun($workflow_id: uuid!) {
    workflow_runs(
      where: { workflow_id: { _eq: $workflow_id }, status: { _in: ["running", "paused"] } }
      limit: 1
    ) {
      id
      status
    }
  }
`;

const CREATE_RUN = `
  mutation CreateRun($workflow_id: uuid!, $triggered_by: uuid, $trigger_type: trigger_type!) {
    insert_workflow_runs_one(object: {
      workflow_id: $workflow_id, status: "running", triggered_by: $triggered_by,
      trigger_type: $trigger_type, started_at: "now()"
    }) { id }
  }
`;

export type StartRunOutcome =
  | { ok: true; runId: string; status: string }
  | { ok: false; status: number; message: string };

export async function startWorkflowRun(params: {
  workflowId: string;
  triggerType: 'manual' | 'webhook' | 'scheduled' | 'event';
  triggeredBy?: string | null;
}): Promise<StartRunOutcome> {
  const { workflowId, triggerType, triggeredBy } = params;

  const workflowData = await adminGraphQL<any>(GET_ORG_QUOTA, {
    workflow_id: workflowId,
  });
  const workflow = workflowData.workflows_by_pk;
  if (!workflow) {
    return { ok: false, status: 404, message: 'Workflow not found' };
  }

  const { quota_limit, quota_used } = workflow.organization;
  if (quota_used >= quota_limit) {
    return { ok: false, status: 429, message: 'Organization quota exhausted' };
  }

  const activeRunCheck = await adminGraphQL<any>(CHECK_ACTIVE_RUN, {
    workflow_id: workflowId,
  });
  if (activeRunCheck.workflow_runs.length > 0) {
    return {
      ok: false,
      status: 409,
      message: `Workflow already has an active run (status: ${activeRunCheck.workflow_runs[0].status})`,
    };
  }

  const { insert_workflow_runs_one: run } = await adminGraphQL<any>(
    CREATE_RUN,
    {
      workflow_id: workflowId,
      triggered_by: triggeredBy ?? null,
      trigger_type: triggerType,
    },
  );

  const result = await runWorkflowLoop({
    workflowId,
    workflowRunId: run.id,
    orgId: workflow.org_id,
    fromStepOrder: 0,
  });

  return { ok: true, runId: run.id, status: result.status };
}
