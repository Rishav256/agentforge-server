import type { Request, Response } from 'express';
import { adminGraphQL } from './_lib/hasura';
import { actionError } from './_lib/actionError';
import { runWorkflowLoop } from './_lib/runWorkflow';

const GET_STEP_RUN_CONTEXT = `
  query GetStepRunContext($step_run_id: uuid!, $user_id: uuid!) {
    step_runs_by_pk(id: $step_run_id) {
      id
      status
      input
      workflow_step { step_order }
      workflow_run {
        id
        workflow {
          id
          org_id
          organization {
            org_members(where: { user_id: { _eq: $user_id } }) { role }
          }
        }
      }
    }
  }
`;

const APPROVE = `
  mutation Approve($step_run_id: uuid!, $workflow_run_id: uuid!, $approved_by: uuid!) {
    update_step_runs_by_pk(pk_columns: { id: $step_run_id }, _set: {
      status: "succeeded", approved_by: $approved_by, approved_at: "now()", completed_at: "now()"
    }) { id }
    update_workflow_runs_by_pk(pk_columns: { id: $workflow_run_id }, _set: { status: "running" }) { id }
  }
`;

export default async function handler(req: Request, res: Response) {
  try {
    if (req.method !== 'POST')
      return actionError(res, 405, 'Method not allowed');

    const { input, session_variables } = req.body;
    const userId = session_variables?.['x-hasura-user-id'];
    const stepRunId = input?.input?.step_run_id;

    if (!userId) return actionError(res, 401, 'Missing session user');
    if (!stepRunId) return actionError(res, 400, 'step_run_id is required');

    const data = await adminGraphQL<any>(GET_STEP_RUN_CONTEXT, {
      step_run_id: stepRunId,
      user_id: userId,
    });
    const stepRun = data.step_runs_by_pk;
    if (!stepRun) return actionError(res, 404, 'Step run not found');
    if (stepRun.status !== 'paused') {
      return actionError(
        res,
        409,
        `Step run is not awaiting approval (status: ${stepRun.status})`,
      );
    }

    const membership =
      stepRun.workflow_run.workflow.organization.org_members[0];
    if (!membership)
      return actionError(res, 403, 'Not a member of this organization');
    if (!['owner', 'editor'].includes(membership.role)) {
      return actionError(
        res,
        403,
        'Only owners and editors can approve a paused step',
      );
    }

    await adminGraphQL(APPROVE, {
      step_run_id: stepRunId,
      workflow_run_id: stepRun.workflow_run.id,
      approved_by: userId,
    });

    const result = await runWorkflowLoop({
      workflowId: stepRun.workflow_run.workflow.id,
      workflowRunId: stepRun.workflow_run.id,
      orgId: stepRun.workflow_run.workflow.org_id,
      fromStepOrder: stepRun.workflow_step.step_order + 1,
      previousOutput: stepRun.input,
    });

    res.status(200).json({ step_run_id: stepRunId, status: result.status });
  } catch (err: any) {
    console.error('approveStep error:', err);
    return actionError(res, 500, 'Internal error approving step');
  }
}
