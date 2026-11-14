const sql = require('mssql');

const config = {
  user: process.env.AZURE_SQL_USER,
  password: process.env.AZURE_SQL_PASSWORD,
  server: process.env.AZURE_SQL_SERVER,
  database: process.env.AZURE_SQL_DATABASE,
  applicationIdentifier: process.env.APPLICATION_IDENTIFIER,
  options: {
    encrypt: process.env.AZURE_SQL_ENCRYPT === 'true',
    trustServerCertificate: false,
  },
};

let sqlConnectionPromise;
let activeOperations = 0;
let idleCloseTimer;
let pendingClose = null;

const IDLE_CLOSE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function scheduleIdleClose() {
  if (idleCloseTimer) {
    clearTimeout(idleCloseTimer);
  }
  idleCloseTimer = setTimeout(async () => {
    if (activeOperations === 0 && sqlConnectionPromise) {
      await closePool();
    }
  }, IDLE_CLOSE_TIMEOUT_MS);
}

async function closePool() {
  if (pendingClose) {
    return pendingClose;
  }

  pendingClose = (async () => {
    try {
      const pool = await sqlConnectionPromise;
      if (pool) {
        await pool.close();
      }
    } finally {
      sqlConnectionPromise = undefined;
      idleCloseTimer = undefined;
      pendingClose = null;
    }
  })();

  return pendingClose;
}

function getSqlConnection() {
  if (!sqlConnectionPromise) {
    sqlConnectionPromise = sql.connect(config).catch((error) => {
      sqlConnectionPromise = undefined;
      throw error;
    });
  }

  return sqlConnectionPromise;
}

async function withSqlConnection(callback) {
  activeOperations++;
  
  if (idleCloseTimer) {
    clearTimeout(idleCloseTimer);
    idleCloseTimer = undefined;
  }

  try {
    await getSqlConnection();
    return await callback();
  } finally {
    activeOperations--;
    if (activeOperations === 0) {
      scheduleIdleClose();
    }
  }
}

function getRequiredApplicationIdentifier() {
  if (!config.applicationIdentifier) {
    throw new Error('Application identifier env var is not configured');
  }

  return config.applicationIdentifier;
}

module.exports = {
  sql,
  withSqlConnection,
  getRequiredApplicationIdentifier,
};