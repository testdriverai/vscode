import { format, transports, createLogger } from 'winston';
import { Env } from './env';
import pkg from '../../package.json';

export const logger = createLogger({
  level: 'debug',
  transports: [new transports.Console({ format: format.simple() })],
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

  logger.transports.push(
    new transports.Http({
      host: 'http-intake.logs.datadoghq.com',
      path: `/api/v2/logs?dd-api-key=${ddClientToken}`,
      ssl: true,
      format: format.json(),
    }),
  );

  return logger;
}
