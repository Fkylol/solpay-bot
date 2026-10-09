import { env } from "../config/env.js";
import { buildChatSystemPrompt } from "../config/app.js";
import { formatPrices, getMarketPrices } from "./prices.js";
import { logger } from "../utils/logger.js";

// Appel direct au LLM (endpoint compatible OpenAI : Groq par défaut).
// Pourquoi un module partagé : le script de simulation et la boucle Telegram
// utilisent exactement le même appel. En production X (plus tard), la réponse
// passera par runtime.useModel avec le même modèle.
// La clé reste dans le header HTTP, jamais dans les logs ni les messages.
export async function generateReplyViaGroq(question: string): Promise<string> {
  // Pourquoi les prix du jour dans le prompt : sans eux, le modèle invente
  // des niveaux et des dates (constaté en live : "support à 90", "Ethereum
  // 2.0"). Ancré sur du réel, il répond juste — c'est aussi ce qui le
  // distingue d'un ChatGPT à données figées.
  let marketLine = "";
  try {
    marketLine = `Prix du jour : ${formatPrices(await getMarketPrices()).replace(/\n/g, " | ")}.`;
  } catch {
    // Pourquoi ce catch vide : sans prix, on répond quand même (le modèle
    // le signale honnêtement au lieu d'inventer, voir consigne ci-dessous).
  }
  // Pourquoi un retry unique : le modèle renvoie parfois un contenu vide
  // (transitoire). Un payé mérite une 2e tentative avant un échec franc.
  // Jamais plus d'un retry : pas de boucle infinie sur quota explosé.
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch(`${env.LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.LLM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.LLM_MODEL,
        messages: [
          { role: "system", content: buildChatSystemPrompt(marketLine) },
          { role: "user", content: question },
        ],
        max_tokens: 300,
      }),
    });
    if (!res.ok) {
      lastError = `LLM ${res.status} : ${(await res.text()).slice(0, 200)}`;
    } else {
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const text = data.choices?.[0]?.message?.content?.trim();
      if (text) return text;
      lastError = "Réponse LLM vide.";
    }
    logger.warn(`[llm] Tentative ${attempt}/2 : ${lastError}`);
  }
  throw new Error(lastError);
}
