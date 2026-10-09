import dotenv from "dotenv";
import { z } from "zod";

// Pourquoi dotenv ici : point d'entrée unique de la config, chargé avant
// tout accès à process.env (y compris par les plugins Eliza).
dotenv.config();

// Pourquoi zod : échouer vite avec un message clair plutôt qu'une erreur
// obscure du plugin LLM au milieu du démarrage.
const envSchema = z.object({
  // --- LLM (obligatoire, endpoint compatible OpenAI : opencode Zen) ---
  LLM_API_KEY: z.string().min(1, "LLM_API_KEY manquante (clé opencode Zen requise)"),
  LLM_BASE_URL: z
    .string()
    .url("LLM_BASE_URL doit être une URL valide, ex. https://opencode.ai/zen/v1"),
  LLM_MODEL: z.string().min(1, "LLM_MODEL manquant, ex. deepseek-v4-flash"),

  // --- Miroirs plugin-openai officiel (optionnels : recopiés depuis LLM_*) ---
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().optional(),
  OPENAI_SMALL_MODEL: z.string().optional(),
  OPENAI_LARGE_MODEL: z.string().optional(),

  // --- Divers ---
  LOG_LEVEL: z.string().default("info"),
  CHAIN_NAME: z.string().optional(),

  // --- X/Twitter (Bloc 3 : boucle payante, DRY_RUN par défaut) ---
  // Pourquoi DRY_RUN=true par défaut : aucun post réel tant que le filtrage
  // payant n'est pas prouvé par la simulation. En mode live (false), les
  // identifiants deviennent obligatoires (vérifié ci-dessous).
  // Note : z.coerce.boolean() ferait Boolean("false") === true, d'où enum + transform.
  TWITTER_DRY_RUN: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  TWITTER_POLL_INTERVAL: z.coerce.number().int().positive().default(60),

  // --- Telegram (boucle payante full-auto, API 100 % gratuite) ---
  // Optionnel : absent => boucle désactivée, le reste tourne normalement.
  // Le token ne sort que dans l'URL d'appel Bot API, jamais dans les logs.
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  // Timeout de long-polling getUpdates (max 50 s côté Telegram).
  TELEGRAM_POLL_TIMEOUT_SEC: z.coerce.number().int().min(5).max(50).default(30),
  // Anti-spam : délai minimum entre deux réponses à un même utilisateur
  // (les preuves !verify passent toujours en priorité, argent d'abord).
  // 20 s par défaut : assez pour protéger le quota Groq gratuit, assez court
  // pour ne pas énerver un utilisateur normal (60 s constaté trop long).
  TELEGRAM_USER_COOLDOWN_SEC: z.coerce.number().int().min(0).max(3600).default(20),

  // --- Produit (SolPay Bot Starter Kit : marque blanche) ---
  // Nom affiché du bot et du personnage Eliza (dérivé : minuscules).
  BOT_NAME: z.string().min(1).default("SolPay"),
  // Symbole du token de paiement (SOL sur Solana, extensible plus tard).
  PAYMENT_TOKEN_SYMBOL: z.string().min(1).default("SOL"),
  // false = version Lite : paywall désactivé, tout le monde est servi.
  // Attention : chaque question consomme alors du quota LLM (voir README).
  // Note : z.coerce.boolean() ferait Boolean("false") === true, d'où enum.
  // Défaut false : un acheteur qui oublie .env ne fait pas payer par erreur.
  PAYWALL_ENABLED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  TWITTER_USERNAME: z.string().optional(),
  TWITTER_PASSWORD: z.string().optional(),
  TWITTER_EMAIL: z.string().optional(),
  TWITTER_API_KEY: z.string().optional(),
  TWITTER_API_SECRET_KEY: z.string().optional(),
  TWITTER_API_SECRET: z.string().optional(),
  TWITTER_ACCESS_TOKEN: z.string().optional(),
  TWITTER_ACCESS_SECRET: z.string().optional(),
  TWITTER_ACCESS_TOKEN_SECRET: z.string().optional(),

  // --- Solana / paiements (Bloc 2, Devnet par défaut, gratuit) ---
  SOLANA_NETWORK: z.enum(["devnet", "mainnet-beta"]).default("devnet"),
  SOLANA_RPC_URL: z.string().url().default("https://api.devnet.solana.com"),
  // Optionnelle : absente => portefeuille Devnet éphémère généré au lancement
  // (pratique pour tester sans clé). Ne jamais la logguer ni la committer.
  SOLANA_PRIVATE_KEY: z.string().min(1).optional(),
  PAYMENT_PRICE_SOL: z.coerce.number().positive().default(0.1),
  PAYMENT_MIN_CONFIRMATIONS: z.coerce.number().int().min(0).max(32).default(1),
  CONFIRM_MAINNET: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

function fail(message: string, issues?: z.ZodIssue[]): never {
  // Pourquoi sans valeurs : on ne logge jamais les secrets, même partiellement.
  console.error("\n[config] Configuration invalide :");
  console.error(`[config] ${message}`);
  for (const issue of issues ?? []) {
    console.error(`[config]  - ${issue.path.join(".") || "(racine)"} : ${issue.message}`);
  }
  console.error("[config] Copie .env.example vers .env puis renseigne les variables.\n");
  process.exit(1);
}

let env: Env;
try {
  env = envSchema.parse(process.env);
} catch (err) {
  if (err instanceof z.ZodError) {
    fail("Variables d'environnement manquantes ou invalides.", err.issues);
  }
  fail(err instanceof Error ? err.message : String(err));
}

// Pourquoi ce miroir : @elizaos/plugin-openai ne lit que OPENAI_*
// (OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_SMALL_MODEL / OPENAI_LARGE_MODEL).
// On propage nos LLM_* pour n'avoir qu'une seule source à remplir dans .env.
process.env.OPENAI_API_KEY ??= env.OPENAI_API_KEY ?? env.LLM_API_KEY;
process.env.OPENAI_BASE_URL ??= env.OPENAI_BASE_URL ?? env.LLM_BASE_URL;
process.env.OPENAI_SMALL_MODEL ??= env.OPENAI_SMALL_MODEL ?? env.LLM_MODEL;
process.env.OPENAI_LARGE_MODEL ??= env.OPENAI_LARGE_MODEL ?? env.LLM_MODEL;
process.env.SMALL_MODEL ??= env.LLM_MODEL;
process.env.LARGE_MODEL ??= env.LLM_MODEL;
process.env.LOG_LEVEL ??= env.LOG_LEVEL;

// Pourquoi pas d'embeddings : vérifié via GET /models sur opencode Zen,
// l'endpoint ne propose aucun modèle d'embedding (que du chat).
// ensureEmbeddingDimension() du core réussit quand même au démarrage car
// le plugin-openai répond localement pour un texte vide (vecteur de test),
// la recherche sémantique restera dégradée tant qu'il n'y a pas de modèle
// d'embedding dédié. On ne bloque pas le démarrage pour ça (bloc 1).

// Pourquoi ce garde-fou : le mainnet manipule de l'argent réel. Le devnet
// est le mode par défaut et suffit au Bloc 2. Pour activer le mainnet, il
// faut explicitement CONFIRM_MAINNET=true, sinon arrêt immédiat.
if (env.SOLANA_NETWORK === "mainnet-beta" && env.CONFIRM_MAINNET !== "true") {
  console.error("\n[config] SOLANA_NETWORK=mainnet-beta sans CONFIRM_MAINNET=true : arrêt.");
  console.error("[config] Le Bloc 2 tourne sur Devnet (gratuit, sans argent réel).");
  console.error("[config] Pour le mainnet, ajoute explicitement CONFIRM_MAINNET=true dans .env.\n");
  process.exit(1);
}

// Pourquoi cette exigence : en mode live, l'agent publie réellement. Sans
// identifiants, le plugin @elizaos/plugin-twitter échouerait en silence au
// premier poll. En DRY_RUN, tout reste optionnel (simulation locale).
if (!env.TWITTER_DRY_RUN) {
  const missing = (["TWITTER_USERNAME", "TWITTER_PASSWORD", "TWITTER_EMAIL"] as const).filter(
    (k) => !env[k],
  );
  if (missing.length > 0) {
    console.error(`\n[config] TWITTER_DRY_RUN=false exige : ${missing.join(", ")}.`);
    console.error("[config] Renseigne-les dans .env ou repasse en mode DRY_RUN.\n");
    process.exit(1);
  }
}

// Pourquoi ces 4 clés : c'est ce qu'exige @elizaos/plugin-twitter 1.2.x
// (schéma zod du plugin : API_KEY, API_SECRET_KEY, ACCESS_TOKEN,
// ACCESS_TOKEN_SECRET). Sans elles, on ne charge pas le plugin.
export function isTwitterConfigured(e: Env = env): boolean {
  return Boolean(
    (e.TWITTER_API_KEY ?? process.env.TWITTER_API_KEY) &&
      (e.TWITTER_API_SECRET_KEY ?? e.TWITTER_API_SECRET) &&
      (e.TWITTER_ACCESS_TOKEN ?? process.env.TWITTER_ACCESS_TOKEN) &&
      (e.TWITTER_ACCESS_TOKEN_SECRET ?? e.TWITTER_ACCESS_SECRET),
  );
}

export { env };
