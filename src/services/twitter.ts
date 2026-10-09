import { env } from "../config/env.js";
import { paymentInvitation } from "../config/app.js";
import { getAgentPublicKey } from "../solana/wallet.js";
import {
  getPayerForTwitter,
  hasActiveAccess,
  linkTwitterAccount,
  verifyPayment,
} from "../solana/payments.js";
import { logger } from "../utils/logger.js";

// Tweet entrant minimal (mention ou reply). Volontairement découplé du
// plugin-twitter : testable sans clés X, branché au plugin au Bloc 4.
export interface IncomingTweet {
  id: string;
  authorId: string;
  authorUsername: string;
  text: string;
}

// Le service ne poste jamais : il rend une décision. L'envoi réel (ou son
// absence en DRY_RUN) appartient à l'appelant. Aucun secret n'est exposé,
// seule l'adresse publique de l'agent figure dans l'invitation.
export type TweetDecision =
  | { kind: "verified-reply"; reply: string; payer: string }
  | { kind: "payment-required"; reply: string }
  | { kind: "invalid-proof"; reply: string; reason: string };

// Pourquoi ce collage : le LLM reçoit la question seule, jamais la preuve
// (signature de 88 caractères qui polluerait le contexte et coûterait des
// tokens). Les dépendances sont injectées pour rester testable sans runtime.
export interface TweetDeps {
  generateReply: (question: string) => Promise<string>;
}

// Preuve : "!verify <SIGNATURE> <ADRESSE>". Plages larges : la validation
// stricte (base58, montants, chaîne) est faite par verifyPayment, pas ici.
const PROOF_RE = /!verify\s+([1-9A-HJ-NP-Za-km-z]{32,128})\s+([1-9A-HJ-NP-Za-km-z]{32,128})/;

export function extractProof(text: string): { signature: string; address: string } | null {
  const match = PROOF_RE.exec(text);
  if (!match?.[1] || !match?.[2]) return null;
  return { signature: match[1], address: match[2] };
}

// Adresse publique de l'agent pour les invitations (info publique).
function agentAddress(): string {
  return getAgentPublicKey().toBase58();
}

export async function handleIncomingTweet(
  tweet: IncomingTweet,
  deps: TweetDeps,
): Promise<TweetDecision> {
  if (!tweet.authorId || !tweet.text) {
    return { kind: "invalid-proof", reason: "invalid-tweet", reply: paymentInvitation(agentAddress()) };
  }

  // Pourquoi ce court-circuit : version Lite (PAYWALL_ENABLED=false), tout
  // le monde est servi sans preuve ni paiement. Attention : chaque question
  // consomme du quota LLM (voir README) — à réserver aux petits volumes.
  if (!env.PAYWALL_ENABLED) {
    const question = tweet.text.replace(PROOF_RE, "").trim();
    if (!question) {
      return { kind: "verified-reply", payer: "lite", reply: "Pose ta question et je te réponds." };
    }
    return { kind: "verified-reply", payer: "lite", reply: await deps.generateReply(question) };
  }

  // Pourquoi vérifier le lien d'abord : un utilisateur déjà payé ne doit
  // pas renvoyer de preuve à chaque tweet (coût nul, friction nulle).
  const linkedPayer = getPayerForTwitter(tweet.authorId);
  const alreadyPaid = linkedPayer !== null && hasActiveAccess(linkedPayer);

  const proof = extractProof(tweet.text);
  let payer: string | null = alreadyPaid ? linkedPayer : null;

  if (proof) {
    const result = await verifyPayment(proof.signature, env.PAYMENT_PRICE_SOL, proof.address);
    if (!result.ok) {
      logger.info("Preuve de paiement rejetée.");
      return {
        kind: "invalid-proof",
        reason: result.reason,
        reply: `Preuve refusée (${result.reason}). ${paymentInvitation(agentAddress())}`,
      };
    }
    // Pourquoi lier après succès seulement : une signature invalide ne doit
    // jamais créer d'association (sinon contournement du paywall).
    linkTwitterAccount(tweet.authorId, tweet.authorUsername, result.payer);
    payer = result.payer;
    logger.info("Paiement validé, compte lié.");
  }

  if (!payer) {
    return { kind: "payment-required", reply: paymentInvitation(agentAddress()) };
  }

  const question = tweet.text.replace(PROOF_RE, "").trim();
  if (!question) {
    return {
      kind: "verified-reply",
      payer,
      reply: "Paiement confirmé. Envoie ta question crypto et je te réponds.",
    };
  }

  // Pourquoi on laisse l'erreur remonter : un appelant (script, plugin) doit
  // voir l'échec LLM au lieu d'envoyer une réponse creuse à un client payant.
  const reply = await deps.generateReply(question);
  return { kind: "verified-reply", payer, reply };
}
