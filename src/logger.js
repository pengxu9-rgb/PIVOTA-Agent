const pino = require('pino');

// Cloud Logging reads an entry's severity from a `severity` field in the JSON line. pino writes only a numeric
// `level`, so without this every gateway line landed as DEFAULT: a WARN or ERROR could not be filtered or alerted
// on by severity. `level` stays numeric (existing queries on jsonPayload.level keep working); `severity` is added.
const CLOUD_LOGGING_SEVERITY = Object.freeze({
  trace: 'DEBUG',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
  fatal: 'CRITICAL',
});

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: null, // keep logs lean; infra can enrich if needed
  formatters: {
    level(label, number) {
      return { level: number, severity: CLOUD_LOGGING_SEVERITY[label] || 'DEFAULT' };
    },
  },
});

module.exports = logger;
