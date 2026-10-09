// Simulation Bloc 3 : boucle payante sans toucher à X (DRY_RUN).
// Usage : npm run test:twitter
// Test 1 : tweet d'un inconnu -> demande de paiement (aucun appel LLM).
// Test 2 : tweet avec preuve on-chain fraîche -> paiement validé + réponse LLM.
import {
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { env } from "../config/env.js";
import { getConnection } from "../solana/connection.js";
import { getAgentPublicKey, sendSolFromAgent } from "../solana/wallet.js";
import { handleIncomingTweet } from "../services/twitter.js";
import { generateReplyViaGroq } from "../services/llm.js";
import { logger } from "../utils/logger.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[test] Assertion : ${message}`);
}

async function testUnpaidUser(): Promise<void> {
  console.log("[test] Test 1 : utilisateur non payant...");
  const decision = await handleIncomingTweet(
    {
      id: "tw_sim_1",
      authorId: "tw_unknown_1",
      authorUsername: "alice_sans_paiement",
      text: "Salut, c'est quoi le Devnet Solana ?",
    },
    { generateReply: generateReplyViaGroq },
  );
  console.log(`[test] Décision : ${JSON.stringify(decision)}`);
  assert(decision.kind === "payment-required", "un impayé doit recevoir payment-required");
  if (decision.kind === "payment-required") {
    assert(decision.reply.includes(getAgentPublicKey().toBase58()), "l'invitation doit contenir l'adresse agent");
    assert(decision.reply.includes(String(env.PAYMENT_PRICE_SOL)), "l'invitation doit contenir le prix");
    assert(decision.reply.includes("!verify"), "l'invitation doit expliquer le format de preuve");
  }
  console.log("[test] Test 1 OK : refus + demande de paiement.\n");
}

async function testPaidUser(): Promise<void> {
  console.log("[test] Test 2 : tweet avec preuve on-chain...");
  const connection = getConnection();
  const agent = getAgentPublicKey();
  const price = env.PAYMENT_PRICE_SOL;

  // Pourquoi un payeur jetable : chaque run rejoue un paiement frais (la
  // signature du Bloc 2 est déjà consommée, l'anti-rejeu la refuserait).
  // L'agent avance les fonds (faucet RPC saturé), comme au Bloc 2.
  const payer = Keypair.generate();
  await sendSolFromAgent(payer.publicKey, Math.round((price + 0.01) * LAMPORTS_PER_SOL));
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: agent,
      lamports: Math.round(price * LAMPORTS_PER_SOL),
    }),
  );
  const signature = await sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: "confirmed",
  });
  console.log(`[test] Paiement on-chain : ${signature}`);

  const tweet = {
    id: "tw_sim_2",
    authorId: "tw_bob_2",
    authorUsername: "bob_qui_paie",
    text: `C'est quoi un portefeuille crypto ? !verify ${signature} ${payer.publicKey.toBase58()}`,
  };
  const decision = await handleIncomingTweet(tweet, { generateReply: generateReplyViaGroq });
  console.log(`[test] Décision : ${JSON.stringify(decision)}`);
  assert(decision.kind === "verified-reply", "une preuve valide doit donner verified-reply");
  if (decision.kind === "verified-reply") {
    assert(decision.reply.length > 10, "la réponse LLM ne doit pas être vide");
    console.log(`[test] Réponse LLM : ${decision.reply}`);
  }

  // Pourquoi rejouer : prouver que la même preuve ne paie qu'une fois.
  const replay = await handleIncomingTweet(
    { ...tweet, id: "tw_sim_2_bis" },
    { generateReply: generateReplyViaGroq },
  );
  console.log(`[test] Rejeu : ${JSON.stringify(replay)}`);
  assert(
    replay.kind === "invalid-proof",
    "une preuve rejouée doit donner invalid-proof",
  );
  console.log("[test] Test 2 OK : paiement validé + réponse LLM + rejeu bloqué.\n");
}

async function main(): Promise<void> {
  try {
    // Pourquoi ce garde : ces simulations valident le paywall. En version
    // Lite (PAYWALL_ENABLED=false), tout le monde est servi : rien à prouver.
    if (!env.PAYWALL_ENABLED) {
      console.error("[test] Simulations paywall : relance avec PAYWALL_ENABLED=true.");
      process.exit(1);
    }
    if (!env.TWITTER_DRY_RUN) {
      throw new Error("[test] Simulation réservée au DRY_RUN (aucun post réel).");
    }
    await testUnpaidUser();
    await testPaidUser();
    console.log("✅ BLOC 3 FONCTIONNEL : filtrage payant (refus impayé, réponse payée).\n");
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "[test] Échec.");
    console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

void main();
