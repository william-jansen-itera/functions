const { randomUUID } = require('crypto');
const { sql, withSqlConnection, getRequiredApplicationIdentifier } = require('./sql');

const LEASE_MINUTES = 11;

async function claimJob(jobId) {
  return withSqlConnection(async () => {
    const token = randomUUID();
    const result = await new sql.Request()
      .input('job_id', sql.UniqueIdentifier, jobId)
      .input('application_identifier', sql.NVarChar(100), getRequiredApplicationIdentifier())
      .input('attempt_token', sql.UniqueIdentifier, token)
      .query(`
        UPDATE job SET status = 'running', attempts = attempts + 1,
          attempt_token = @attempt_token, lease_until = DATEADD(minute, ${LEASE_MINUTES}, SYSUTCDATETIME()),
          updated_at = SYSUTCDATETIME()
        OUTPUT INSERTED.tree_instance_id AS treeId, INSERTED.input_payload AS inputPayload,
          INSERTED.attempt_token AS attemptToken
        FROM dbo.tree_jobs job
        INNER JOIN dbo.application_instance ai ON ai.id = job.application_instance_id
        INNER JOIN dbo.tree_instance ti ON ti.id = job.tree_instance_id AND ti.application_instance_id = ai.id
        WHERE job.id = @job_id AND job.job_type = 'populate' AND ai.app_identifier = @application_identifier
          AND ti.deleted_at IS NULL
          AND (job.status = 'queued' OR (job.status = 'running' AND job.lease_until < SYSUTCDATETIME()));
      `);
    if (result.recordset[0]) {
      const { inputPayload, ...job } = result.recordset[0];
      const { treeName, description } = JSON.parse(inputPayload);
      return { ...job, name: treeName, description };
    }

    const existing = await new sql.Request()
      .input('job_id', sql.UniqueIdentifier, jobId)
      .input('application_identifier', sql.NVarChar(100), getRequiredApplicationIdentifier())
      .query(`
        SELECT job.status FROM dbo.tree_jobs job
        INNER JOIN dbo.application_instance ai ON ai.id = job.application_instance_id
        WHERE job.id = @job_id AND job.job_type = 'populate' AND ai.app_identifier = @application_identifier;
      `);
    if (existing.recordset[0]?.status === 'running') throw new Error('Populate job is already running.');
    return null;
  });
}

async function renewJob(jobId, token) {
  return withSqlConnection(async () => {
    const result = await new sql.Request()
      .input('job_id', sql.UniqueIdentifier, jobId)
      .input('attempt_token', sql.UniqueIdentifier, token)
      .query(`
        UPDATE dbo.tree_jobs
        SET lease_until = DATEADD(minute, ${LEASE_MINUTES}, SYSUTCDATETIME()), updated_at = SYSUTCDATETIME()
        WHERE id = @job_id AND attempt_token = @attempt_token AND status = 'running';
      `);
    if (result.rowsAffected[0] !== 1) throw new Error('Populate job lease was lost.');
  });
}

async function markFailed(jobId, token, summary) {
  return withSqlConnection(async () => new sql.Request()
    .input('job_id', sql.UniqueIdentifier, jobId)
    .input('attempt_token', sql.UniqueIdentifier, token)
    .input('summary', sql.NVarChar(500), summary)
    .query(`
      UPDATE dbo.tree_jobs SET status = 'failed', failure_summary = @summary,
        lease_until = NULL, finished_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME()
      WHERE id = @job_id AND attempt_token = @attempt_token AND status = 'running';
    `));
}

async function releaseJob(jobId, token) {
  return withSqlConnection(async () => new sql.Request()
    .input('job_id', sql.UniqueIdentifier, jobId)
    .input('attempt_token', sql.UniqueIdentifier, token)
    .query(`
      UPDATE dbo.tree_jobs SET status = 'queued', attempt_token = NULL, lease_until = NULL,
        updated_at = SYSUTCDATETIME()
      WHERE id = @job_id AND attempt_token = @attempt_token AND status = 'running';
    `));
}

async function insertBranch(transaction, treeId, nodes, parentId, depth) {
  let count = 0;
  for (const node of nodes) {
    const leaf = depth === 3;
    const inserted = await new sql.Request(transaction)
      .input('tree_id', sql.Int, treeId)
      .input('parent_id', sql.Int, parentId)
      .input('title', sql.NVarChar(255), node.title)
      .input('is_leaf', sql.Bit, leaf ? 1 : 0)
      .query(`
        DECLARE @created TABLE (id INT);
        INSERT dbo.tree_nodes (tree_instance_id, parent_id, text, is_leaf_node, is_expanded, draggable, sort_order)
        OUTPUT INSERTED.id INTO @created
        SELECT @tree_id, @parent_id, @title, @is_leaf, CASE WHEN @is_leaf = 1 THEN 0 ELSE 1 END, 1,
          ISNULL(MAX(sort_order), -1) + 1
        FROM dbo.tree_nodes
        WHERE tree_instance_id = @tree_id AND
          ((@parent_id IS NULL AND parent_id IS NULL) OR parent_id = @parent_id) AND deleted_at IS NULL;
        SELECT id FROM @created;
      `);
    const nodeId = inserted.recordset[0].id;
    count += 1;
    if (leaf) {
      await new sql.Request(transaction)
        .input('node_id', sql.Int, nodeId)
        .input('notes', sql.NVarChar(sql.MAX), node.notes)
        .query(`
          MERGE dbo.tree_node_details AS target
          USING (SELECT @node_id AS tree_node_id) AS source
          ON target.tree_node_id = source.tree_node_id
          WHEN MATCHED THEN UPDATE SET notes = @notes, is_secret = 0, secret_metadata = NULL,
            updated_at = SYSUTCDATETIME()
          WHEN NOT MATCHED THEN INSERT (tree_node_id, notes, is_secret, secret_metadata, created_at, updated_at)
            VALUES (@node_id, @notes, 0, NULL, SYSUTCDATETIME(), SYSUTCDATETIME());
        `);
    } else {
      count += await insertBranch(transaction, treeId, node.children, nodeId, depth + 1);
    }
  }
  return count;
}

async function finishJob(jobId, token, nodes) {
  return withSqlConnection(async () => {
    const transaction = new sql.Transaction();
    await transaction.begin();
    try {
      const result = await new sql.Request(transaction)
        .input('job_id', sql.UniqueIdentifier, jobId)
        .input('attempt_token', sql.UniqueIdentifier, token)
        .input('application_identifier', sql.NVarChar(100), getRequiredApplicationIdentifier())
        .query(`
          SELECT job.tree_instance_id AS treeId,
            CASE WHEN CONVERT(VARBINARY(MAX), ti.description) = CONVERT(VARBINARY(MAX), snapshot.description) THEN 1 ELSE 0 END AS sameDescription,
            TRY_CAST(setting.setting_value AS INT) AS maxDepth
          FROM dbo.tree_jobs job WITH (UPDLOCK, HOLDLOCK)
          CROSS APPLY OPENJSON(job.input_payload) WITH (description NVARCHAR(MAX) '$.description') snapshot
          INNER JOIN dbo.application_instance ai ON ai.id = job.application_instance_id
          INNER JOIN dbo.tree_instance ti WITH (UPDLOCK, HOLDLOCK)
            ON ti.id = job.tree_instance_id AND ti.application_instance_id = ai.id
          LEFT JOIN dbo.tree_setting setting ON setting.tree_instance_id = ti.id AND setting.setting_key = 'nodes.max_depth'
          WHERE job.id = @job_id AND job.job_type = 'populate'
            AND job.attempt_token = @attempt_token AND job.status = 'running'
            AND ai.app_identifier = @application_identifier AND ti.deleted_at IS NULL;
        `);
      const scope = result.recordset[0];
      if (!scope || !scope.sameDescription || Number(scope.maxDepth) !== 3) {
        throw new Error('Tree or saved description changed, or maximum tree depth is not 3.');
      }
      const totalNodeCount = await insertBranch(transaction, scope.treeId, nodes, null, 0);
      await new sql.Request(transaction)
        .input('tree_id', sql.Int, scope.treeId)
        .query('UPDATE dbo.tree_instance SET updated_at = SYSUTCDATETIME() WHERE id = @tree_id;');
      const completion = await new sql.Request(transaction)
        .input('job_id', sql.UniqueIdentifier, jobId)
        .input('attempt_token', sql.UniqueIdentifier, token)
        .input('root_count', sql.Int, nodes.length)
        .input('total_count', sql.Int, totalNodeCount)
        .query(`
          UPDATE dbo.tree_jobs SET status = 'succeeded',
            result_payload = (SELECT @root_count AS rootNodeCount, @total_count AS totalNodeCount FOR JSON PATH, WITHOUT_ARRAY_WRAPPER),
            lease_until = NULL, finished_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME()
          WHERE id = @job_id AND attempt_token = @attempt_token AND status = 'running';
        `);
      if (completion.rowsAffected[0] !== 1) throw new Error('Populate job completion was rejected.');
      await transaction.commit();
      return totalNodeCount;
    } catch (error) {
      if (transaction._aborted !== true) await transaction.rollback();
      throw error;
    }
  });
}

module.exports = { claimJob, renewJob, finishJob, releaseJob, markFailed };