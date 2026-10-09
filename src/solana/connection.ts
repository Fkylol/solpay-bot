import { Connection } from "@solana/web3.js";
import { env } from "../config/env.js";

// Pourquoi un singleton : une seule connexion HTTP réutilisée par tout
// l'agent (wallet, paiements, scripts), pas une par appel.
let cached: Connection | null = null;

export function getConnection(): Connection {
  if (!cached) {
    cached = new Connection(env.SOLANA_RPC_URL, "confirmed");
  }
  return cached;
}

// Pourquoi ce healthcheck : prouve que le RPC répond avant toute logique
// (mauvais réseau, URL invalide, RPC hors ligne détectés tôt).
// Retourne la version du validateur, ex. "1.18.26".
export async function solanaHealthcheck(): Promise<string> {
  const version = await getConnection().getVersion();
  return version["solana-core"];
}
