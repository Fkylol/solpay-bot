import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { env } from "../config/env.js";
import { getConnection } from "./connection.js";
import { logger } from "../utils/logger.js";

// Pourquoi ce module est le seul à voir la clé privée : il la charge, la
// garde en mémoire, et n'expose que la clé publique + le solde. Aucun autre
// fichier ne l'importe en clair, aucun log ne la contient (même partielle).
let cached: Keypair | null = null;

function loadAgentKeypair(): Keypair {
  if (cached) return cached;
  const raw = env.SOLANA_PRIVATE_KEY?.trim();
  if (raw) {
    let bytes: Uint8Array;
    try {
      bytes = bs58.decode(raw);
    } catch {
      // Pourquoi sans détail : ne jamais faire fuiter le contenu de la clé,
      // même sous forme d'erreur (longueur, préfixe...).
      throw new Error("[wallet] SOLANA_PRIVATE_KEY invalide (base58 attendu).");
    }
    if (bytes.length !== 64) {
      throw new Error("[wallet] SOLANA_PRIVATE_KEY invalide (64 octets attendus).");
    }
    cached = Keypair.fromSecretKey(bytes);
  } else {
    // Pourquoi un éphémère plutôt qu'un crash : le Bloc 2 doit pouvoir se
    // tester sur Devnet sans clé préexistante. Perdu à chaque redémarrage,
    // donc réservé aux tests (jamais de mainnet sans clé persistante).
    logger.warn("[wallet] Pas de SOLANA_PRIVATE_KEY : portefeuille éphémère (Devnet test uniquement).");
    cached = Keypair.generate();
  }
  return cached;
}

// Seule sortie publique autorisée avec le solde ci-dessous.
export function getAgentPublicKey(): PublicKey {
  return loadAgentKeypair().publicKey;
}

// Solde en SOL (pas en lamports) pour rester lisible côté appelants.
export async function getAgentBalance(): Promise<number> {
  const lamports = await getConnection().getBalance(getAgentPublicKey(), "confirmed");
  return lamports / LAMPORTS_PER_SOL;
}

// Envoie des SOL depuis le wallet agent. Seule fonction autorisée à signer
// avec la clé agent : la clé ne sort jamais du module, seule la signature
// est retournée. Sert aux tests (avance de fonds) et futurs reversements.
export async function sendSolFromAgent(to: PublicKey, lamports: number): Promise<string> {
  const connection = getConnection();
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: getAgentPublicKey(), toPubkey: to, lamports }),
  );
  return sendAndConfirmTransaction(connection, tx, [loadAgentKeypair()], {
    commitment: "confirmed",
  });
}
