import pino from "pino";

// Pourquoi pino-pretty en dev : logs lisibles sous Windows (couleurs,
// horodatage local). En prod, JSON brut pour un collecteur de logs.
// Les secrets ne sont jamais loggés : voir `redact` ci-dessous.
const isDev = process.env.NODE_ENV !== "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  // Pourquoi `transport` conditionnel : pino-pretty est une devDependency,
  // on ne veut pas le charger en production.
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:standard" },
        },
      }
    : {}),
  // Pourquoi `redact` : garde-fou global contre toute fuite de secret
  // dans les logs (même accidentelle via un objet d'erreur).
  redact: {
    paths: [
      "*.apiKey",
      "*.api_key",
      "*API_KEY*",
      "*TOKEN*",
      "*SECRET*",
      "*PASSWORD*",
      "*PRIVATE_KEY*",
      "LLM_API_KEY",
      "OPENAI_API_KEY",
    ],
    censor: "[REDACTED]",
  },
});
