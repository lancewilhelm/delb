import pino, { type Logger, type LoggerOptions } from 'pino';

const isProduction = process.env['NODE_ENV'] === 'production';
const requestedLogLevel = process.env['LOG_LEVEL'];
const logLevel = (requestedLogLevel || (isProduction ? 'warn' : 'debug')) as
  | LoggerOptions['level']
  | undefined;

const pinoConfig: LoggerOptions = isProduction
  ? {
      level: logLevel,
      browser: { asObject: true },
    }
  : {
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
      level: logLevel,
      browser: { asObject: false },
    };

export const logger: Logger = pino(pinoConfig);
