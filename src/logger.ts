import pino from 'pino';

const isDevMode = (process.env.NODE_ENV || 'development') === 'development';

const logger = pino({
  level: process.env.LOG_LEVEL || (isDevMode ? 'debug' : 'info'),
  // Replace default base (pid, hostname) with service-level fields for ES/CloudWatch aggregation
  base: {
    service: 'proofport-ai',
    env: process.env.DEPLOY_ENV || process.env.NODE_ENV || 'development',
  },
  // ISO 8601 timestamps — human-readable, CloudWatch parses natively
  timestamp: pino.stdTimeFunctions.isoTime,
  // Level as string ("info") instead of number (30)
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  ...(isDevMode
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname,component,service,env',
            singleLine: true,
            messageFormat: '[{component}] {msg}',
          },
        },
      }
    : {}),
  redact: {
    paths: [
      'privateKey',
      'proverPrivateKey',
      'settlementPrivateKey',
      'signature',
      'authorization.signature',
      'sessionSecret',
      'apiSecret',
      'apiKey',
      'password',
    ],
    censor: '[REDACTED]',
  },
});

export { logger };

export function createLogger(component: string) {
  return logger.child({ component });
}
