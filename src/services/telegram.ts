import { env } from "../config/env.js";
import { cooldownMessage, helpText } from "../config/app.js";
import { claimFreeGrant, getPayerForTwitter, hasActiveAccess, peekFreeGrant } from "../solana/payments.js";
import { extractProof, handleIncomingTweet } from "./twitter.js";
import { formatPrices, getMarketPrices } from "./prices.js";
import { logger } from "../utils/logger.js";

// Boucle payante Telegram (Bot API 100 % gratuite, lecture + écriture).
// Pourquoi réutiliser handleIncomingTweet : mêmes règles que X (preuve,
// liaison, anti-rejeu, invitation), seul l'identifiant change (tg:<id>).
// Le token ne figure que dans l'URL d'appel, jamais dans les logs.

export interface TelegramDeps {
  generateReply: (question: string) => Promise<string>;
  // Pourquoi injectable : la simulation passe 0 pour tester sans attendre,
  // la boucle live utilise TELEGRAM_USER_COOLDOWN_SEC.
  cooldownSec?: number;
}

interface TgFrom {
  id: number;
  username?: string;
  first_name?: string;
}
interface TgMessage {
  message_id: number;
  from?: TgFrom;
  chat: { id: number };
  text?: string;
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

// Dernier traitement par utilisateur (anti-spam, en mémoire).
const lastReplyAt = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Commandes gratuites (aucun paiement, aucun appel LLM, aucun cooldown).
// Pourquoi avant le paywall : c'est l'appât gratuit qui attire les futurs
// payants. Seules les questions libres restent derrière le paywall.
export async function handleFreeCommand(text: string): Promise<string | null> {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  if (cmd === "/help") {
    return helpText();
  }
  if (cmd === "/prix") {
    try {
      const prices = await getMarketPrices();
      return formatPrices(prices, rest[0]);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Prix indisponibles.",
      );
      return "Prix momentanément indisponibles, réessaie dans 2 min.";
    }
  }
  return null;
}

async function botApi<T>(method: string, params: Record<string, unknown>): Promise<T> {
  // Pourquoi env lu ici et pas en paramètre : un seul endroit connaît le
  // token, et il n'est jamais interpolé dans un message de log.
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    throw new Error(`Telegram ${method} : HTTP ${res.status}`);
  }
  const data = (await res.json()) as { ok: boolean; result: T; description?: string };
  if (!data.ok) {
    throw new Error(`Telegram ${method} : ${data.description ?? "échec"}`);
  }
  return data.result;
}

// Traite un message texte, retourne le texte à envoyer ou null (rien à dire).
// Testable sans réseau Telegram (seuls Solana + LLM sont appelés via deps).
export async function processTelegramText(
  from: TgFrom,
  text: string,
  deps: TelegramDeps,
): Promise<{ reply: string } | null> {
  const authorId = `tg:${from.id}`;
  const username = from.username ?? from.first_name ?? String(from.id);
  const cooldownMs = (deps.cooldownSec ?? env.TELEGRAM_USER_COOLDOWN_SEC) * 1000;
  const now = Date.now();

  // Pourquoi le cooldown ne vise que les payés : l'invitation et le refus
  // sont gratuits (aucun appel LLM), seul le bavardage des payés consomme
  // du quota Groq. Effet voulu : /start n'arme plus le cooldown des nouveaux
  // (c'était le cas avant, un vrai bug d'accueil constaté en live).
  // Pourquoi tout ce bloc est sauté en Lite : sans paywall, pas de tickets,
  // pas de throttle — handleIncomingTweet sert tout le monde (quota LLM à
  // surveiller, voir README).
  const proof = extractProof(text);
  if (env.PAYWALL_ENABLED && proof === null) {
    const linked = getPayerForTwitter(authorId);
    const paid = linked !== null && hasActiveAccess(linked);
    if (paid) {
      const last = lastReplyAt.get(authorId) ?? 0;
      if (now - last < cooldownMs) {
        const waitSec = Math.ceil((cooldownMs - (now - last)) / 1000);
        return { reply: cooldownMessage(waitSec) };
      }
    } else {
      // Pourquoi ici : offre de lancement "10 premières questions offertes".
      // Un impayé sans preuve consomme son unique ticket gratuit (réponse LLM
      // + mention), puis retombe sur le paywall classique. Coût borné : 10
      // réponses max, jamais plus (plafond en base, anti-sybill de poche).
      // Pourquoi consommer APRÈS la réponse : un échec LLM ne doit pas
      // brûler le ticket de l'utilisateur (ni faire échouer les retries).
      if (peekFreeGrant(authorId) === "available") {
        const reply = await deps.generateReply(text);
        claimFreeGrant(authorId);
        lastReplyAt.set(authorId, now);
        return {
          reply: `${reply}\n\nC'était ta question offerte (lancement). Les suivantes : ${env.PAYMENT_PRICE_SOL} ${env.PAYMENT_TOKEN_SYMBOL}, voir /start.`,
        };
      }
    }
  }

  const decision = await handleIncomingTweet(
    { id: `${authorId}:${now}`, authorId, authorUsername: username, text },
    deps,
  );
  lastReplyAt.set(authorId, now);
  return { reply: decision.reply };
}

async function handleUpdate(update: TgUpdate, deps: TelegramDeps): Promise<void> {
  try {
    const msg = update.message;
    // Pourquoi on ignore le reste : seuls les messages texte privés/groupes
    // nous intéressent (pas de stickers, pas d'éditions, pas de callbacks).
    if (!msg?.from || typeof msg.text !== "string" || msg.text.trim() === "") return;
    if (msg.text.length > 2000) {
      await botApi("sendMessage", { chat_id: msg.chat.id, text: "Message trop long, résume en 2000 caractères." });
      return;
    }
    // Pourquoi les commandes gratuites d'abord : /prix et /help ne passent
    // ni par le paywall ni par le cooldown (zéro coût, accueil immédiat).
    const free = await handleFreeCommand(msg.text);
    if (free !== null) {
      await botApi("sendMessage", { chat_id: msg.chat.id, text: free });
      return;
    }
    const result = await processTelegramText(msg.from, msg.text, deps);
    if (result) {
      await botApi("sendMessage", { chat_id: msg.chat.id, text: result.reply });
    }
  } catch (err) {
    // Pourquoi on ne propage pas : une update pourrie ne doit jamais tuer
    // la boucle (poll suivant avec offset avancé quand même).
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Update Telegram ignorée.",
    );
  }
}

export interface TelegramHandle {
  botUsername: string;
  stop: () => void;
  done: Promise<void>;
}

// Démarre la boucle. Retourne null (sans jeter) si pas de token ou token
// invalide : l'agent continue sans Telegram. L'appelant garde `stop` pour
// l'arrêt propre (SIGINT/SIGTERM dans index.ts).
export async function startTelegramLoop(deps: TelegramDeps): Promise<TelegramHandle | null> {
  if (!env.TELEGRAM_BOT_TOKEN?.trim()) {
    logger.info("Pas de TELEGRAM_BOT_TOKEN : boucle Telegram désactivée.");
    return null;
  }
  let me: { id: number; username?: string };
  try {
    me = await botApi<{ id: number; username?: string }>("getMe", {});
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Token Telegram invalide : boucle désactivée.",
    );
    return null;
  }
  const botUsername = me.username ? `@${me.username}` : `id:${me.id}`;
  logger.info(`Bot Telegram connecté : ${botUsername}.`);

  let stopped = false;
  let offset = 0;
  const done = (async () => {
    while (!stopped) {
      try {
        const updates = await botApi<TgUpdate[]>("getUpdates", {
          offset,
          timeout: env.TELEGRAM_POLL_TIMEOUT_SEC,
          allowed_updates: ["message"],
        });
        for (const update of updates) {
          offset = Math.max(offset, update.update_id + 1);
          if (stopped) break;
          await handleUpdate(update, deps);
        }
      } catch (err) {
        if (stopped) break;
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "Poll Telegram en échec, nouvel essai dans 5 s.",
        );
        await sleep(5000);
      }
    }
  })();

  return { botUsername, stop: () => { stopped = true; }, done };
}
