import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers['set-cookie']",
      "*.password",
      "*.password_hash",
      "*.ssn",
      "*.last_4_ssn",
      "*.date_of_birth",
      "*.phone",
      "*.phone_primary",
      "*.street_address",
      "*.diagnosis",
      "*.medications",
      "*.background_check_data",
      "*.encryption_key",
    ],
    censor: "[REDACTED]",
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
