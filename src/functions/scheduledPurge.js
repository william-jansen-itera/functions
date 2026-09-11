const { app } = require('@azure/functions');
const { getRequiredApplicationIdentifier, withSqlConnection } = require('../lib/sql');
const { runExpiredRetentionPurge } = require('../lib/purgeService');

const DEFAULT_PURGE_JOB_SCHEDULE = '0 0 2 * * *';

app.timer('scheduledPurge', {
  schedule: process.env.PURGE_JOB_SCHEDULE || DEFAULT_PURGE_JOB_SCHEDULE,
  runOnStartup: false,
  handler: async (_timer, context) => {
    const applicationIdentifier = getRequiredApplicationIdentifier();

    context.log(`Starting scheduled purge for application ${applicationIdentifier}.`);

    const result = await withSqlConnection(async () => runExpiredRetentionPurge(applicationIdentifier));

    context.log('Scheduled purge completed.', result);
  },
});

module.exports = {
  DEFAULT_PURGE_JOB_SCHEDULE,
};