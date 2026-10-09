import { env } from "./env.js";

// Pourquoi ce module : un seul endroit pour la marque, les textes et les
// prompts. Le kit se marque blanche en changeant .env (BOT_NAME,
// PAYMENT_TOKEN_SYMBOL...), sans toucher au code. Aucune valeur perso ici.
export const botName = env.BOT_NAME;
export const botUsername = env.BOT_NAME.toLowerCase().replace(/[^a-z0-9]+/g, "");
export const tokenSymbol = env.PAYMENT_TOKEN_SYMBOL;
export const priceLabel = `${env.PAYMENT_PRICE_SOL} ${env.PAYMENT_TOKEN_SYMBOL}`;

// Invitation à payer : seule phrase qui cite l'adresse de l'agent.
// L'adresse est passée en paramètre (info publique), jamais la clé privée.
export function paymentInvitation(agentAddress: string): string {
  return (
    `Accès payant (${priceLabel}, Solana ${env.SOLANA_NETWORK}) : ` +
    `envoie ${priceLabel} à ${agentAddress}, puis réponds avec : !verify <signature> <ton-adresse-solana>`
  );
}

export function cooldownMessage(waitSec: number): string {
  return `Doucement ! Repose ta question dans ${waitSec} s.`;
}

export function helpText(): string {
  return (
    "Commandes gratuites : /prix [btc|sol], /help. Première question offerte (lancement, 10 premières).\n" +
    `Questions perso ensuite : ${priceLabel} (voir /start), puis !verify <signature> <adresse>.`
  );
}

// Prompt système des réponses payantes. marketLine = prix du jour (ou vide).
export function buildChatSystemPrompt(marketLine: string): string {
  return [
    `Tu es ${botName}, assistant crypto. Réponds en français, tutoiement, ton direct.`,
    "80 mots max. Aucun conseil d'achat, de vente ni de timing :",
    "à 'quand acheter ?', explique la méthode (DCA, supports, gestion du risque), jamais un ordre.",
    marketLine,
    marketLine
      ? "Utilise ces prix s'ils servent. Sans données récentes, dis-le au lieu d'inventer."
      : "Tu n'as pas les prix du jour : dis-le et reste général, n'invente aucun niveau.",
  ].join(" ");
}

// Prompt du digest X quotidien.
export function buildDigestPrompt(facts: string): string {
  return `Résume ces prix en UN tweet français de 220 caractères max, ton direct, sans promesse de gains. Prix : ${facts}`;
}
