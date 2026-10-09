import { buildDigestPrompt } from "../config/app.js";
import { formatPrices, getMarketPrices } from "./prices.js";
import { generateReplyViaGroq } from "./llm.js";

// Construit un digest marché publiable sur X (≤ 270 caractères, marge sous
// la limite 280). Pourquoi Groq + repli chiffres bruts : si le LLM échoue,
// on publie des prix factuels plutôt que rien. Rien n'est posté ici, voir
// src/scripts/post-digest.ts (flag --post explicite).
export async function buildDigest(): Promise<string> {
  const prices = await getMarketPrices();
  const facts = formatPrices(prices);
  try {
    const text = await generateReplyViaGroq(buildDigestPrompt(facts));
    const tweet = `${text.trim()} #Bitcoin #Solana`.slice(0, 270);
    if (tweet.length >= 40) return tweet;
  } catch {
    // Pourquoi ce catch vide : le repli chiffres bruts suit.
  }
  return `${facts} #Bitcoin #Solana`.slice(0, 270);
}
