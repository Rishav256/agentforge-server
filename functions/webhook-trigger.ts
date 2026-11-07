import type { Request, Response } from 'express';
import { adminGraphQL } from './_lib/hasura';
import { actionError } from './_lib/actionError';
import { startWorkflowRun } from './_lib/startRun';

const GET_TRIGGER = `
  query GetTrigger($id: uuid!) {
    workflow_triggers_by_pk(id: $id) {
      id
      type
      config
      workflow_id
    }
  }
`;

export default async function handler(req: Request, res: Response) {
  try {
    if (req.method !== 'POST')
      return actionError(res, 405, 'Method not allowed');

    const triggerId = req.query.trigger_id as string | undefined;
    const secret = req.query.secret as string | undefined;

    if (!triggerId) return actionError(res, 400, 'trigger_id is required');
    if (!secret) return actionError(res, 401, 'secret is required');

    const data = await adminGraphQL<any>(GET_TRIGGER, { id: triggerId });
    const trigger = data.workflow_triggers_by_pk;

    if (!trigger) return actionError(res, 404, 'Trigger not found');
    if (trigger.type !== 'webhook')
      return actionError(res, 400, 'Trigger is not a webhook type');

    const expectedSecret = trigger.config?.secret;
    if (!expectedSecret || secret !== expectedSecret) {
      return actionError(res, 401, 'Invalid secret');
    }

    const outcome = await startWorkflowRun({
      workflowId: trigger.workflow_id,
      triggerType: 'webhook',
      triggeredBy: null,
    });

    if (outcome.ok === false)
      return actionError(res, outcome.status, outcome.message);

    res.status(200).json({ run_id: outcome.runId, status: outcome.status });
  } catch (err: any) {
    console.error('webhook-trigger error:', err);
    return actionError(res, 500, 'Internal error triggering webhook');
  }
}
