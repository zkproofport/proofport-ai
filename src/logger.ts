import pino from 'pino';

const isDevMode = (process.env.NODE_ENV || 'development') === 'development';

const logger = pino({
  level: process.env.LOG_LEVEL || (isDevMode ? 'debug' : 'info'),
  ...(isDevMode
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname,component',
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
