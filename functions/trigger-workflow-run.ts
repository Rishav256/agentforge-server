import type { Request, Response } from 'express';
import { adminGraphQL } from './_lib/hasura';
import { actionError } from './_lib/actionError';
import { startWorkflowRun } from './_lib/startRun';

const GET_WORKFLOW_AND_MEMBERSHIP = `
  query GetWorkflowAndMembership($workflow_id: uuid!, $user_id: uuid!) {
    workflows_by_pk(id: $workflow_id) {
      id
      organization {
        org_members(where: { user_id: { _eq: $user_id } }) { role }
      }
    }
  }
`;

export default async function handler(req: Request, res: Response) {
  try {
    if (req.method !== 'POST')
      return actionError(res, 405, 'Method not allowed');

    const { input, session_variables } = req.body;
    const userId = session_variables?.['x-hasura-user-id'];
    const workflowId = input?.input?.workflow_id;

    if (!userId) return actionError(res, 401, 'Missing session user');
    if (!workflowId) return actionError(res, 400, 'workflow_id is required');

    const data = await adminGraphQL<any>(GET_WORKFLOW_AND_MEMBERSHIP, {
      workflow_id: workflowId,
      user_id: userId,
    });
    const workflow = data.workflows_by_pk;
    if (!workflow) return actionError(res, 404, 'Workflow not found');

    const membership = workflow.organization.org_members[0];
    if (!membership)
      return actionError(res, 403, 'Not a member of this organization');
    if (membership.role === 'viewer')
      return actionError(res, 403, 'Viewers cannot trigger workflow runs');

    const outcome = await startWorkflowRun({
      workflowId,
      triggerType: 'manual',
      triggeredBy: userId,
    });

    if (outcome.ok === false)
      return actionError(res, outcome.status, outcome.message);

    res.status(200).json({ run_id: outcome.runId, status: outcome.status });
  } catch (err: any) {
    console.error('triggerWorkflowRun error:', err);
    return actionError(res, 500, 'Internal error triggering workflow run');
  }
}
