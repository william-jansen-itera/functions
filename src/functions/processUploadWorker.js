const { app } = require('@azure/functions');
const { claimUpload, renewUpload, finishUpload, releaseUpload } = require('../lib/chatUploadJob');
const { waitForIndexedUpload, generateTemporaryNote, stopIndexingAndDeleteDocument } = require('../lib/chatUploadProcessing');

app.storageQueue('processUploadWorker', {
  queueName: 'chat-upload-jobs',
  connection: 'CHAT_UPLOAD_STORAGE_CONNECTION_STRING',
  handler: async (message, context) => {
    const uploadId = String(message?.uploadId ?? '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uploadId)) {
      throw new Error('Invalid chat upload job message.');
    }
    const upload = await claimUpload(uploadId);
    if (!upload) return;

    const heartbeat = setInterval(() => {
      renewUpload(uploadId, upload.attemptToken).catch((error) => context.error('Upload lease renewal failed.', error));
    }, 20_000);

    try {
      const { text, partial } = await waitForIndexedUpload({
        uploadId, ownerObjectId: upload.ownerObjectId,
        onProgress: () => renewUpload(uploadId, upload.attemptToken),
      });
      const note = await generateTemporaryNote({ fileName: upload.fileName, text, partial });
      await stopIndexingAndDeleteDocument(upload.blobName, uploadId);
      await finishUpload(uploadId, upload.attemptToken, note);
      context.log(`Processed temporary chat upload ${uploadId}.`);
    } catch (error) {
      context.error(`Temporary chat upload ${uploadId} failed.`, error);
      const failed = Number(context.triggerMetadata?.dequeueCount ?? 1) >= 5;
      await releaseUpload(uploadId, upload.attemptToken, {
        failed, reason: failed ? 'File processing failed after multiple attempts.' : null,
      });
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  },
});