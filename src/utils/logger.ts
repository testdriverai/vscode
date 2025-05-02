import * as vscode from 'vscode';
import Analytics from 'analytics-node';
import { format, transports, createLogger } from 'winston';
import { Env } from './env';
import pkg from '../../package.json';

let userId = '';
let machineId = '';

const analytics = new Analytics('dnhLCaCxKyJhOqOgXmAyHzcbPrfsB09e');
export const logger = createLogger({
  level: 'debug',
  transports: [
    new transports.Console({
      format: format.combine(
        format.errors({ stack: true }),
        format.timestamp(),
        format.colorize(),
        format.printf((info) => {
          let stack = '';
          if ('stack' in info) {
            stack = `\n${info.stack}`;
          }
          return `${info.timestamp} ${info.level}: ${
            typeof info.message === 'string'
              ? info.message
              : JSON.stringify(info.message, null, 2)
          } ${JSON.stringify(
            omit(info, [
              'stack',
              'message',
              'level',
              'service',
              'version',
              'env',
              'timestamp',
              'machineId',
              'userId',
            ]),
            null,
            2,
          )}${stack}`;
        }),
      ),
    }),
  ],
});

function omit<R extends Record<string | number | symbol, unknown>>(
  obj: R,
  keys: Array<keyof R>,
): Omit<R, keyof typeof keys> {
  const result = { ...obj };
  for (const key of keys) {
    delete result[key];
  }
  return result as Omit<R, keyof typeof keys>;
}

export function init(context: vscode.ExtensionContext, env: Env) {
  const ddClientToken = 'pub24e93578176f1a88e1da4ef7bf77eb50';

  if (env !== 'development') {
    logger.level = 'info';
  }

  if (!machineId) {
    machineId = context.globalState.get('machineId') ?? crypto.randomUUID();
    userId = (context.globalState.get('userId') ?? '') as string;
    context.globalState.update('machineId', machineId);
  }

  logger.defaultMeta = {
    env,
    service: 'vscode',
    version: pkg.version,
    machineId,
  };

  logger.add(
    new transports.Http({
      host: 'http-intake.logs.datadoghq.com',
      path: `/api/v2/logs?dd-api-key=${ddClientToken}`,
      ssl: true,
      format: format.json(),
    }),
  );
}

export const setUser = (id: string | null) => {
  userId = id ?? '';
  const defaultMeta = logger.defaultMeta ?? {};
  if (userId) {
    logger.defaultMeta = { ...defaultMeta, userId };
  } else {
    logger.defaultMeta = { ...omit(defaultMeta, ['userId']) };
  }
};

export const track = (payload: {
  event: string;
  properties?: Record<string, unknown>;
  timestamp?: Date;
  context?: Record<string, unknown>;
}) => {
  logger.info(payload.event, payload.properties);
  return analytics.track({
    ...(userId ? { userId } : { anonymousId: machineId }),
    ...payload,
    properties: {
      ...(payload.properties ?? {}),
      machineId,
    },
  });
};
