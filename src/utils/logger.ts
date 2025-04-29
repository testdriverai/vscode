import { format, transports, createLogger } from 'winston';
import { Env } from './env';
import pkg from '../../package.json';

export const logger = createLogger({
  level: 'debug',
  transports: [
    new transports.Console({
      format: format.combine(
        format.errors({ stack: true }),
        format.label({ label: pkg.version }),
        format.timestamp(),
        format.colorize(),
        format.align(),
        // format.simple(),
        format.printf((info) => {
          let stack = '';
          if ('stack' in info) {
            stack = `\n${info.stack}`;
          }
          return `${info.timestamp} [${info.label}] ${info.level}: ${
            typeof info.message === 'string'
              ? info.message
              : JSON.stringify(info.message, null, 2)
          }${stack}`;
        }),
      ),
    }),
  ],
});

export function init(env: Env) {
  const ddClientToken = 'pub24e93578176f1a88e1da4ef7bf77eb50';

  if (env !== 'development') {
    logger.level = 'info';
  }

  logger.defaultMeta = {
    env,
    service: 'vscode',
    version: pkg.version,
  };

  logger.add(
    new transports.Http({
      host: 'http-intake.logs.datadoghq.com',
      path: `/api/v2/logs?dd-api-key=${ddClientToken}`,
      ssl: true,
      format: format.json(),
    }),
  );

  return logger;
}
