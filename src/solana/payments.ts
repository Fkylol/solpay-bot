import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  LAMPORTS_PER_SOL,
  PublicKey,
  type Finality,
} from "@solana/web3.js";
import { env } from "../config/env.js";
import { getConnection } from "./connection.js";
import { getAgentPublicKey } from "./wallet.js";
import { logger } from "../utils/logger.js";

// Pourquoi better-sqlite3 synchrone ici : les lectures/écritures anti-rejeu
// sont instantanées et locales. Le réseau (RPC Solana) reste asynchrone.
// Pourquoi ce chemin : base prod par défaut, base jetable pour les tests
// (PAYMENTS_DB_PATH=data/payments-test.db via cross-env dans les scripts
// npm). Sans isolation, les simulations rempliraient la base live et
// épuiseraient le plafond des questions offertes.
const DB_PATH = process.env.PAYMENTS_DB_PATH ?? join(process.cwd(), "data", "payments.db");
mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
// Pourquoi WAL : la base peut être lue par l'agent et le script de test en
// même temps sans verrous bloquants.
db.pragma("journal_mode = WAL");
db.exec(`CREATE TABLE IF NOT EXISTS payments (
  signature TEXT PRIMARY KEY,
  payer TEXT NOT NULL,
  amount_sol REAL NOT NULL,
  created_at INTEGER NOT NULL
)`);
// Pourquoi cette table : associe un compte X (id stable) à l'adresse Solana
// qui a payé. Un utilisateur déjà lié saute la preuve aux prochains tweets
// (vérifié via hasActiveAccess sur son adresse).
db.exec(`CREATE TABLE IF NOT EXISTS linked_accounts (
  twitter_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  payer TEXT NOT NULL,
  linked_at INTEGER NOT NULL
)`);

const findBySignature = db.prepare("SELECT signature FROM payments WHERE signature = ?");
const findByPayer = db.prepare("SELECT signature FROM payments WHERE payer = ? LIMIT 1");
const insertPayment = db.prepare(
  "INSERT INTO payments (signature, payer, amount_sol, created_at) VALUES (?, ?, ?, ?)",
);
const findLink = db.prepare("SELECT payer FROM linked_accounts WHERE twitter_id = ?");
const upsertLink = db.prepare(
  `INSERT INTO linked_accounts (twitter_id, username, payer, linked_at)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(twitter_id) DO UPDATE SET username = excluded.username, payer = excluded.payer, linked_at = excluded.linked_at`,
);
// Pourquoi cette table : offre de lancement "10 premières questions offertes".
// Une ligne = un utilisateur ayant consommé sa question gratuite. Plafond
// global (pas par utilisateur) : coût LLM borné même en cas d'afflux.
db.exec(`CREATE TABLE IF NOT EXISTS free_grants (
  twitter_id TEXT PRIMARY KEY,
  granted_at INTEGER NOT NULL
)`);
const countGrants = db.prepare("SELECT COUNT(*) AS n FROM free_grants");
const findGrant = db.prepare("SELECT twitter_id FROM free_grants WHERE twitter_id = ?");
const insertGrant = db.prepare("INSERT INTO free_grants (twitter_id, granted_at) VALUES (?, ?)");

export const FREE_LAUNCH_CAP = 10;

// Dit si un ticket gratuit reste pour cet utilisateur, sans le consommer.
export function peekFreeGrant(twitterId: string): "available" | "already-used" | "cap-reached" {
  if (findGrant.get(twitterId) !== undefined) return "already-used";
  const used = (countGrants.get() as { n: number }).n;
  return used >= FREE_LAUNCH_CAP ? "cap-reached" : "available";
}

// Réclame la question gratuite de lancement : "granted" une seule fois par
// utilisateur et 10 fois au total, sinon motif du refus (paywall classique).
export function claimFreeGrant(twitterId: string): "granted" | "already-used" | "cap-reached" {
  if (findGrant.get(twitterId) !== undefined) return "already-used";
  const used = (countGrants.get() as { n: number }).n;
  if (used >= FREE_LAUNCH_CAP) return "cap-reached";
  insertGrant.run(twitterId, Date.now());
  return "granted";
}

export type VerifyPaymentResult =
  | { ok: true; signature: string; payer: string; amountSol: number }
  | {
      ok: false;
      reason:
        | "already-used"
        | "not-found"
        | "failed-transaction"
        | "wrong-destination"
        | "wrong-sender"
        | "amount-mismatch"
        | "invalid-input"
        | "internal-error";
      detail?: string;
    };

// Pourquoi ce niveau de confirmations : PAYMENT_MIN_CONFIRMATIONS >= 2 exige
// 'finalized' (le plus sûr), sinon 'confirmed' suffit sur Devnet (Bloc 2).
function commitmentFor(): Finality {
  return env.PAYMENT_MIN_CONFIRMATIONS >= 2 ? "finalized" : "confirmed";
}

// Vérifie qu'une signature correspond à un vrai paiement : transaction
// confirmée, réussie, avec un transfert SystemProgram du montant attendu,
// du payeur attendu, vers le wallet de l'agent. Enregistre la signature
// pour interdire toute réutilisation (anti-rejeu).
export async function verifyPayment(
  signature: string,
  expectedAmountSol: number,
  payerAddress: string,
): Promise<VerifyPaymentResult> {
  if (!signature || typeof signature !== "string") {
    return { ok: false, reason: "invalid-input", detail: "Signature vide." };
  }
  let payer: PublicKey;
  try {
    payer = new PublicKey(payerAddress);
  } catch {
    return { ok: false, reason: "invalid-input", detail: "Adresse du payeur invalide." };
  }
  if (!Number.isFinite(expectedAmountSol) || expectedAmountSol <= 0) {
    return { ok: false, reason: "invalid-input", detail: "Montant attendu invalide." };
  }

  try {
    // Pourquoi d'abord la BDD : refuser le rejeu sans même appeler le RPC.
    const known = findBySignature.get(signature) as { signature: string } | undefined;
    if (known) {
      return { ok: false, reason: "already-used", detail: "Signature déjà utilisée." };
    }

    const tx = await getConnection().getParsedTransaction(signature, {
      commitment: commitmentFor(),
      maxSupportedTransactionVersion: 0,
    });
    // Pourquoi null = rejet : transaction inconnue ou pas encore au niveau
    // de confirmation exigé. On ne devine jamais, on refuse.
    if (!tx) {
      return { ok: false, reason: "not-found", detail: "Transaction introuvable ou non confirmée." };
    }
    if (tx.meta?.err) {
      return { ok: false, reason: "failed-transaction", detail: "Transaction en échec on-chain." };
    }

    const agent = getAgentPublicKey().toBase58();
    const payer58 = payer.toBase58();
    const expectedLamports = Math.round(expectedAmountSol * LAMPORTS_PER_SOL);
    let toAgentExists = false;
    let fromPayerExists = false;
    let matchedLamports = 0;

    for (const ix of tx.transaction.message.instructions) {
      // Pourquoi on ignore le non-parsé : seuls les transferts SystemProgram
      // décodés sont interprétables sans ambiguïté.
      if (!("parsed" in ix)) continue;
      if (ix.program !== "system") continue;
      const parsed = ix.parsed as { type?: string; info?: Record<string, unknown> };
      if (parsed?.type !== "transfer") continue;
      const info = parsed.info ?? {};
      if (info["destination"] !== agent) continue;
      toAgentExists = true;
      if (info["source"] !== payer58) continue;
      fromPayerExists = true;
      const lamports = Number(info["lamports"] ?? 0);
      if (Number.isFinite(lamports) && lamports > matchedLamports) {
        matchedLamports = lamports;
      }
    }

    if (!toAgentExists) {
      return { ok: false, reason: "wrong-destination", detail: "Aucun transfert vers le wallet agent." };
    }
    if (!fromPayerExists) {
      return { ok: false, reason: "wrong-sender", detail: "Transfert présent mais pas depuis ce payeur." };
    }
    if (matchedLamports < expectedLamports) {
      return {
        ok: false,
        reason: "amount-mismatch",
        detail: `Montant insuffisant : ${matchedLamports / LAMPORTS_PER_SOL} SOL < ${expectedAmountSol} SOL.`,
      };
    }

    const amountSol = matchedLamports / LAMPORTS_PER_SOL;
    insertPayment.run(signature, payer58, amountSol, Date.now());
    logger.info("Paiement vérifié et enregistré.");
    return { ok: true, signature, payer: payer58, amountSol };
  } catch (err) {
    // Pourquoi ok:false plutôt que throw : l'appelant (script, futur Bloc 3)
    // traite un refus comme une donnée, pas comme un crash.
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Erreur interne verifyPayment.",
    );
    return { ok: false, reason: "internal-error", detail: "Erreur RPC ou BDD." };
  }
}

// Accès actif = au moins un paiement vérifié pour ce payeur.
// (Pas d'expiration au Bloc 2 : la durée d'accès viendra au Bloc 3.)
export function hasActiveAccess(payerAddress: string): boolean {
  try {
    const payer = new PublicKey(payerAddress).toBase58();
    return findByPayer.get(payer) !== undefined;
  } catch {
    return false;
  }
}

// Mémorise qu'un compte X a payé depuis une adresse (après verifyPayment OK).
// Un compte ne peut être lié qu'à une adresse à la fois (upsert).
export function linkTwitterAccount(twitterId: string, username: string, payerAddress: string): void {
  const payer = new PublicKey(payerAddress).toBase58();
  upsertLink.run(twitterId, username, payer, Date.now());
}

// Retrouve l'adresse Solana liée à un compte X, ou null si jamais lié.
export function getPayerForTwitter(twitterId: string): string | null {
  const row = findLink.get(twitterId) as { payer: string } | undefined;
  return row?.payer ?? null;
}
