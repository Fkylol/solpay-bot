import { AgentRuntime, ModelType, stringToUuid } from "@elizaos/core";
import type { AgentRuntime as AgentRuntimeType, Plugin } from "@elizaos/core";
import openaiPlugin from "@elizaos/plugin-openai";
import bootstrapPlugin from "@elizaos/plugin-bootstrap";
import sqlPlugin from "@elizaos/plugin-sql";
import { TwitterPlugin } from "@elizaos/plugin-twitter";
import { env, isTwitterConfigured } from "./config/env.js";
import { character } from "./character/character.js";
import { customPlugins } from "./plugins/index.js";
import { generateReplyViaGroq } from "./services/llm.js";
import { startTelegramLoop } from "./services/telegram.js";
import { logger } from "./utils/logger.js";

// Pourquoi les plugins sont assemblés ici : un seul endroit décide quoi
// charger (sql + openai + bootstrap toujours, twitter seulement si clés
// complètes). Le personnage reste déclaratif, sans logique conditionnelle.
function buildPlugins(): Plugin[] {
  const plugins: Plugin[] = [sqlPlugin, openaiPlugin, bootstrapPlugin, ...customPlugins];
  if (isTwitterConfigured()) {
    logger.info("Clés X détectées : plugin Twitter activé.");
    plugins.push(TwitterPlugin as unknown as Plugin);
  } else {
    logger.info("Clés X absentes/incomplètes : plugin Twitter désactivé.");
  }
  return plugins;
}

async function testLlmConnection(runtime: AgentRuntimeType): Promise<void> {
  // Pourquoi ce test : prouver que LLM_BASE_URL + clé + modèle fonctionnent
  // avant toute logique métier. TEXT_SMALL utilise OPENAI_SMALL_MODEL.
  try {
    const result = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: "Dis BONJOUR en une phrase.",
    });
    const text = typeof result === "string" ? result : JSON.stringify(result);
    console.log(`\n✅ LLM OK — réponse : ${text}\n`);
    logger.info("Test LLM réussi.");
  } catch (err) {
    // Pourquoi on ne crash pas sur les embeddings ici : seul TEXT_SMALL est
    // testé. Un échec = URL/clé/modèle invalide ou endpoint injoignable.
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Échec du test LLM. Vérifie LLM_BASE_URL, LLM_API_KEY et LLM_MODEL dans .env.",
    );
    throw err;
  }
}

async function main(): Promise<void> {
  let runtime: AgentRuntimeType | null = null;
  // Pourquoi ce garde-fou : un service peut rejeter après l'init (ex. le
  // service Twitter sur un compte X gratuit : l'API répond 402 sur les
  // lectures). Sans handler, Node tue tout le processus. On loggue et on
  // continue en mode dégradé : les Blocs 1-3 restent en vie sans X.
  process.on("unhandledRejection", (reason: unknown) => {
    logger.error(
      { err: reason instanceof Error ? reason.message : String(reason) },
      "Rejet non géré (service dégradé, l'agent continue).",
    );
  });
  try {
    const agentId = stringToUuid(character.name);
    const plugins = buildPlugins();

    // Pourquoi ce log : en DRY_RUN, le plugin Twitter (s'il est configuré)
    // tourne sans publier, et la boucle payante (src/services/twitter.ts) ne
    // fait que décider + logguer. Aucune réponse réelle sur X.
    if (env.TWITTER_DRY_RUN) {
      logger.warn("⚠️ Mode Twitter DRY_RUN actif : aucune publication réelle ne sera faite sur X.");
    } else {
      logger.info(`Plugin Twitter en mode LIVE (poll toutes les ${env.TWITTER_POLL_INTERVAL}s).`);
    }

    // Pourquoi ces settings : @elizaos/plugin-openai ne lit que OPENAI_*
    // (pas LLM_*). env.ts les a déjà recopiés dans process.env, on les
    // repasse explicitement au runtime pour être sûr (small + large).
    runtime = new AgentRuntime({
      agentId,
      character,
      plugins,
      settings: {
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? env.LLM_API_KEY,
        OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? env.LLM_BASE_URL,
        OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL ?? env.LLM_MODEL,
        OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL ?? env.LLM_MODEL,
        SMALL_MODEL: env.LLM_MODEL,
        LARGE_MODEL: env.LLM_MODEL,
      },
    });

    // Pourquoi un handler d'arrêt propre : PGlite/SQLite garde un handle
    // de fichier, il faut le fermer sur SIGINT/SIGTERM (Ctrl+C, arrêt Docker).
    // La boucle Telegram est stoppée aussi (le poll en cours finit, pas de
    // message à moitié envoyé : l'envoi est atomique par update).
    let stopTelegram: (() => void) | null = null;
    const shutdown = async (signal: string) => {
      logger.info(`Signal ${signal} reçu, arrêt propre...`);
      stopTelegram?.();
      try {
        await runtime?.stop();
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Erreur à l'arrêt.");
      } finally {
        process.exit(0);
      }
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));

    // Pourquoi en deux temps : avec @elizaos/core 1.7.2, initialize() appelle
    // ensureAgentExists() AVANT runPluginMigrations(). Sur une base fraîche
    // (PGlite), la table `agents` n'existe pas encore -> échec systématique
    // au premier démarrage. On enregistre donc les plugins puis on migre
    // explicitement avant l'init complète. registerPlugin() est idempotent
    // (ignoré si déjà enregistré), le second passage est sans effet.
    for (const plugin of plugins) {
      await runtime.registerPlugin(plugin);
    }
    await runtime.runPluginMigrations();
    // Pourquoi initialize() ici : les plugins sont prêts et le schéma existe,
    // le runtime finalise agent/entité/room puis le test LLM prouve la
    // connexion au modèle.
    await runtime.initialize();
    logger.info(
      { plugins: plugins.map((p) => p.name) },
      "Runtime Eliza initialisé (base locale PGlite).",
    );

    await testLlmConnection(runtime);
    // Pourquoi ce bilan : un service peut s'être dégradé en arrière-plan
    // (ex. Twitter sans tier X payant). Visible d'un coup d'œil dans les logs.
    try {
      logger.info(
        { services: runtime.getRegisteredServiceTypes(), health: runtime.getServiceHealth() },
        "État des services.",
      );
    } catch {
      // Pourquoi ce catch vide : le bilan est informatif, jamais bloquant.
    }
    // Pourquoi en arrière-plan et après le test LLM : la boucle Telegram vit
    // tant que l'agent tourne, sans bloquer le runtime. Sans token (ou token
    // invalide), simple log et on continue : les Blocs 1-3 restent en vie.
    // Même generateReply que la simulation (src/services/llm.ts).
    const telegram = await startTelegramLoop({ generateReply: generateReplyViaGroq });
    if (telegram) {
      stopTelegram = telegram.stop;
      logger.info(`Boucle Telegram active (${telegram.botUsername}).`);
    }
    logger.info("Agent prêt. Ctrl+C pour arrêter.");
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Démarrage impossible.",
    );
    try {
      await runtime?.stop();
    } catch {
      // Pourquoi ce catch vide : on est déjà en échec, l'arrêt ne doit pas
      // masquer l'erreur d'origine.
    }
    process.exit(1);
  }
}

void main();
