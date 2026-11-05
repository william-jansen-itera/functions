const { app } = require('@azure/functions');
const { sql, withSqlConnection, getRequiredApplicationIdentifier } = require('../lib/sql');
const { generateTreeNodesFromDescription } = require('../lib/treePopulateGeneration');
const { claimJob, renewJob, finishJob, releaseJob, markFailed } = require('../lib/treePopulateJob');

app.storageQueue('treePopulateWorker', {
  queueName: 'tree-populate-jobs',
  handler: async (message, context) => {
    const jobId = String(message?.jobId ?? '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) {
      throw new Error('Invalid populate job message.');
    }

    const job = await claimJob(jobId);
    if (!job) return;

    const heartbeat = setInterval(() => {
      renewJob(jobId, job.attemptToken).catch((error) => context.error('Populate lease renewal failed.', error));
    }, 60_000);

    try {
      const nodes = await generateTreeNodesFromDescription({ name: job.name, description: job.description },
        () => renewJob(jobId, job.attemptToken));
      const total = await finishJob(jobId, job.attemptToken, nodes);
      context.log(`Populate job ${jobId} inserted ${total} nodes.`);
    } catch (error) {
      context.error(`Populate job ${jobId} failed.`, error);
      if (Number(context.triggerMetadata?.dequeueCount ?? 1) >= 5) {
        await markFailed(jobId, job.attemptToken, 'Tree population failed after multiple attempts.');
      } else {
        await releaseJob(jobId, job.attemptToken);
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  },
});

app.timer('treePopulateRecovery', {
  schedule: '0 */15 * * * *',
  handler: async (_timer, context) => {
    const result = await withSqlConnection(async () => new sql.Request()
      .input('application_identifier', sql.NVarChar(100), getRequiredApplicationIdentifier())
      .query(`
        UPDATE job SET status = 'failed', failure_summary = 'Tree population stopped before completion.',
          finished_at = SYSUTCDATETIME(), lease_until = NULL, updated_at = SYSUTCDATETIME()
        FROM dbo.tree_jobs job
        INNER JOIN dbo.application_instance ai ON ai.id = job.application_instance_id
        WHERE ai.app_identifier = @application_identifier AND job.job_type = 'populate'
          AND ((job.status = 'queued' AND job.updated_at < DATEADD(hour, -2, SYSUTCDATETIME()))
            OR (job.status = 'running' AND job.lease_until < DATEADD(minute, -15, SYSUTCDATETIME())));
      `));
    context.log(`Reconciled ${result.rowsAffected[0]} stale Populate jobs.`);
  },
});