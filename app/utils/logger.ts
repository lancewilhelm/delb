import pino, { type Logger } from "pino";

let pinoConfig;

if (
  process.env["NODE_ENV"] === "production" &&
  process.env["LOG_LEVEL"] !== "debug"
) {
  pinoConfig = {
    level: "warn",
    browser: {
      asObject: true,
    },
  };
} else {
  pinoConfig = {
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
      },
    },
    level: "debug",
    browser: {
      asObject: false,
    },
  };
}

export const logger: Logger = pino(pinoConfig);
