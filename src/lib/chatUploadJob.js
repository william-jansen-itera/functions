const { randomUUID } = require('node:crypto');
const { sql, withSqlConnection, getRequiredApplicationIdentifier } = require('./sql');

async function claimUpload(uploadId) {
  return withSqlConnection(async () => {
    const result = await new sql.Request()
      .input('id', sql.UniqueIdentifier, uploadId)
      .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
      .input('token', sql.UniqueIdentifier, randomUUID())
      .query(`
        UPDATE u SET status = N'running', attempts = attempts + 1, attempt_token = @token,
          lease_until = DATEADD(second, 75, SYSUTCDATETIME()), updated_at = SYSUTCDATETIME()
        OUTPUT inserted.blob_name AS blobName, inserted.file_name AS fileName,
          inserted.owner_object_id AS ownerObjectId, inserted.attempt_token AS attemptToken
        FROM dbo.chat_uploads u
        INNER JOIN dbo.application_instance ai ON ai.id = u.application_instance_id
        WHERE u.id = @id AND ai.app_identifier = @application_identifier
          AND u.expires_at > SYSUTCDATETIME()
          AND (u.status = N'queued' OR (u.status = N'running' AND u.lease_until < SYSUTCDATETIME()));
      `);
    if (result.recordset[0]) return result.recordset[0];
    const active = await new sql.Request()
      .input('id', sql.UniqueIdentifier, uploadId)
      .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
      .query(`
        SELECT TOP 1 u.id FROM dbo.chat_uploads u
        INNER JOIN dbo.application_instance ai ON ai.id = u.application_instance_id
        WHERE u.id = @id AND ai.app_identifier = @application_identifier
          AND u.status = N'running' AND u.lease_until >= SYSUTCDATETIME();
      `);
    if (active.recordset.length) throw new Error('Chat upload is still leased; retry the queue message.');
    return null;
  });
}

async function renewUpload(uploadId, token) {
  const result = await withSqlConnection(() => new sql.Request()
    .input('id', sql.UniqueIdentifier, uploadId)
    .input('token', sql.UniqueIdentifier, token)
    .query(`
      UPDATE dbo.chat_uploads SET lease_until = DATEADD(second, 75, SYSUTCDATETIME()),
        updated_at = SYSUTCDATETIME()
      WHERE id = @id AND attempt_token = @token AND status = N'running'
        AND expires_at > SYSUTCDATETIME();
    `));
  if (result.rowsAffected[0] !== 1) throw new Error('Chat upload lease was lost.');
}

async function completeChatUploadProcessing(uploadId, token, { note, caption, saveKind, extractedNoteText }) {
  if (!['note', 'attachment'].includes(saveKind) ||
      (saveKind === 'note' && (!extractedNoteText || extractedNoteText.length > 4000)) ||
      (saveKind === 'attachment' && extractedNoteText != null)) {
    throw new Error('Invalid chat upload save classification.');
  }
  const result = await withSqlConnection(() => new sql.Request()
    .input('id', sql.UniqueIdentifier, uploadId)
    .input('token', sql.UniqueIdentifier, token)
    .input('note', sql.NVarChar(1000), note)
    .input('caption', sql.NVarChar(2000), caption)
    .input('save_kind', sql.NVarChar(20), saveKind)
    .input('extracted_note_text', sql.NVarChar(4000), extractedNoteText)
    .query(`
      UPDATE dbo.chat_uploads SET status = N'succeeded', note = @note, caption = @caption,
        save_kind = @save_kind, extracted_note_text = @extracted_note_text,
        lease_until = NULL, updated_at = SYSUTCDATETIME()
      WHERE id = @id AND attempt_token = @token AND status = N'running'
        AND expires_at > SYSUTCDATETIME();
    `));
  if (result.rowsAffected[0] !== 1) throw new Error('Chat upload completion was rejected.');
}

async function releaseUpload(uploadId, token, { failed = false, reason = null } = {}) {
  await withSqlConnection(() => new sql.Request()
    .input('id', sql.UniqueIdentifier, uploadId)
    .input('token', sql.UniqueIdentifier, token)
    .input('status', sql.NVarChar(20), failed ? 'failed' : 'queued')
    .input('reason', sql.NVarChar(500), reason)
    .query(`
      UPDATE dbo.chat_uploads SET status = @status, failure_summary = @reason,
        attempt_token = NULL, lease_until = NULL, updated_at = SYSUTCDATETIME()
      WHERE id = @id AND attempt_token = @token AND status = N'running';
    `));
}

module.exports = { claimUpload, renewUpload, completeChatUploadProcessing, releaseUpload };