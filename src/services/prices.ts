// Prix gratuits via CoinGecko (sans clé, quotas serrés : cache 120 s).
// Pourquoi CoinGecko et pas un oracle on-chain : un seul appel HTTP pour
// BTC+SOL avec variation 24 h, suffisant pour un digest et /prix.
// Les commandes gratuites n'appellent jamais le LLM : coût nul garanti.
interface GeckoResponse {
  bitcoin?: { usd?: number; usd_24h_change?: number };
  solana?: { usd?: number; usd_24h_change?: number };
}

export interface MarketPrices {
  btcUsd: number | null;
  btcChange24h: number | null;
  solUsd: number | null;
  solChange24h: number | null;
  fetchedAt: number;
}

let cache: MarketPrices | null = null;
const CACHE_MS = 120_000;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export async function getMarketPrices(): Promise<MarketPrices> {
  // Pourquoi ce cache : l'API gratuite bannit vite en cas de spam, et les
  // prix n'ont pas besoin d'être à la seconde près pour ce bot.
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache;
  const res = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,solana&vs_currencies=usd&include_24hr_change=true",
    { headers: { "User-Agent": "crypto-agent/0.1" } },
  );
  if (!res.ok) {
    // Pourquoi servir le vieux cache plutôt que jeter : un digest avec des
    // prix vieux de 10 min vaut mieux qu'aucun digest.
    if (cache) return cache;
    throw new Error(`CoinGecko HTTP ${res.status}`);
  }
  const data = (await res.json()) as GeckoResponse;
  cache = {
    btcUsd: num(data.bitcoin?.usd),
    btcChange24h: num(data.bitcoin?.usd_24h_change),
    solUsd: num(data.solana?.usd),
    solChange24h: num(data.solana?.usd_24h_change),
    fetchedAt: Date.now(),
  };
  return cache;
}

function fmtUsd(v: number | null): string {
  if (v === null) return "n/a";
  return v.toLocaleString("fr-FR", { maximumFractionDigits: v < 100 ? 2 : 0 });
}

export function fmtChange(v: number | null): string {
  if (v === null) return "";
  const sign = v >= 0 ? "+" : "";
  return ` (${sign}${v.toFixed(1)} % 24h)`;
}

// Texte /prix : déterministe, sans LLM, donc gratuit même spammé.
export function formatPrices(p: MarketPrices, asset?: string): string {
  const a = asset?.toUpperCase();
  const lines: string[] = [];
  if (!a || a === "BTC" || a === "BITCOIN") {
    lines.push(`BTC : ${fmtUsd(p.btcUsd)} $US${fmtChange(p.btcChange24h)}`);
  }
  if (!a || a === "SOL" || a === "SOLANA") {
    lines.push(`SOL : ${fmtUsd(p.solUsd)} $US${fmtChange(p.solChange24h)}`);
  }
  if (lines.length === 0) return "Actifs suivis : BTC, SOL. Exemple : /prix sol";
  return lines.join("\n");
}
