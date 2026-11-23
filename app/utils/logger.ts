type LogFn = (...args: unknown[]) => void;

export interface AppLogger {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
}

const isProduction = import.meta.env.PROD;

export const logger: AppLogger = {
  debug: (...args) => {
    if (!isProduction) console.debug(...args);
  },
  info: (...args) => {
    if (!isProduction) console.info(...args);
  },
  warn: (...args) => {
    console.warn(...args);
  },
  error: (...args) => {
    console.error(...args);
  },
};
