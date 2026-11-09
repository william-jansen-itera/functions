const { app } = require('@azure/functions');
const { purgeExpiredChatUploads } = require('../lib/chatUploadCleanup');

app.timer('chatUploadCleanup', {
  schedule: '0 0 0 * * *',
  runOnStartup: false,
  handler: async (_timer, context) => {
    const deleted = await purgeExpiredChatUploads(context);
    context.log(`Cleaned up ${deleted} expired chat upload(s).`);
  },
});