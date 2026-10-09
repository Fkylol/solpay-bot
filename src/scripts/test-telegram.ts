// Simulation de la boucle Telegram sans serveur Telegram.
// Usage : npm run test:telegram
// Test 1 : message d'un inconnu -> invitation à payer (zéro réseau).
// Test 2 : preuve on-chain fraîche -> réponse LLM + rejeu bloqué.
// Test 3 : deux messages rapprochés -> anti-spam (cooldown).
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
import { generateReplyViaGroq } from "../services/llm.js";
import { handleFreeCommand, processTelegramText } from "../services/telegram.js";
import { logger } from "../utils/logger.js";

const deps = { generateReply: generateReplyViaGroq };

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[test] Assertion : ${message}`);
}

async function testUnpaid(): Promise<void> {
  console.log("[test] Test 1 : utilisateur Telegram non payant...");
  const result = await processTelegramText(
    { id: 91001, username: "alice_tg" },
    "Salut, c'est quoi le Devnet Solana ?",
    deps,
  );
  console.log(`[test] Réponse : ${result?.reply}`);
  assert(result !== null, "un impayé doit recevoir une réponse");
  assert(result?.reply.includes(getAgentPublicKey().toBase58()) ?? false, "invitation avec adresse agent");
  assert(result?.reply.includes("!verify") ?? false, "invitation avec format de preuve");
  console.log("[test] Test 1 OK.\n");
}

async function testPaid(): Promise<{ id: number; username: string }> {
  console.log("[test] Test 2 : preuve on-chain via Telegram...");
  const connection = getConnection();
  const agent = getAgentPublicKey();
  const price = env.PAYMENT_PRICE_SOL;

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

  const from = { id: 91002, username: "bob_tg" };
  const text = `C'est quoi un portefeuille crypto ? !verify ${signature} ${payer.publicKey.toBase58()}`;
  const result = await processTelegramText(from, text, deps);
  console.log(`[test] Réponse LLM : ${result?.reply}`);
  assert((result?.reply.length ?? 0) > 10, "réponse LLM non vide");

  const replay = await processTelegramText(from, text, deps);
  console.log(`[test] Rejeu : ${replay?.reply}`);
  assert(replay?.reply.includes("already-used") ?? false, "rejeu bloqué");
  console.log("[test] Test 2 OK.\n");
  return from;
}

async function testCooldown(paidFrom: { id: number; username: string }): Promise<void> {
  console.log("[test] Test 3 : anti-spam (payé qui mitraille)...");
  // Pourquoi l'utilisateur payé du Test 2 : le cooldown ne vise que les
  // payés (l'invitation des impayés est gratuite, jamais ralentie).
  const second = await processTelegramText(paidFrom, "Encore une question ?", deps);
  console.log(`[test] Réponse : ${second?.reply}`);
  assert(second?.reply.startsWith("Doucement") ?? false, "second message ralenti");
  console.log("[test] Test 3 OK.\n");
}

async function testFreeCommands(): Promise<void> {
  console.log("[test] Test 4 : commandes gratuites...");
  // Pourquoi du réseau réel ici : CoinGecko gratuit, mis en cache 120 s.
  const prix = await handleFreeCommand("/prix sol");
  console.log(`[test] /prix sol : ${prix}`);
  assert((prix ?? "").includes("SOL"), "/prix doit afficher SOL");
  const help = await handleFreeCommand("/help");
  console.log(`[test] /help : ${help}`);
  assert((help ?? "").includes("/prix"), "/help doit lister /prix");
  const unknown = await handleFreeCommand("bonjour");
  assert(unknown === null, "un texte normal n'est pas une commande");
  console.log("[test] Test 4 OK.\n");
}

async function testFreeGrant(): Promise<void> {
  console.log("[test] Test 5 : offre de lancement (10 gratuites)...");
  // Pourquoi en premier : remplit le plafond pour que les tests suivants
  // (invitation impayé) soient déterministes.
  for (let i = 0; i < 10; i++) {
    const r = await processTelegramText(
      { id: 93000 + i, username: `free_${i}` },
      `Question offerte ${i} : c'est quoi le staking ?`,
      deps,
    );
    assert((r?.reply.includes("question offerte") ?? false), `utilisateur ${i} servi gratis`);
  }
  const sameAgain = await processTelegramText(
    { id: 93000, username: "free_0" },
    "Encore une ?",
    deps,
  );
  assert((sameAgain?.reply.includes("!verify") ?? false), "2e question du même -> paywall");
  const eleventh = await processTelegramText(
    { id: 93999, username: "trop_tard" },
    "Et moi ?",
    deps,
  );
  assert((eleventh?.reply.includes("!verify") ?? false), "11e utilisateur -> paywall (plafond)");
  console.log("[test] Test 5 OK : 10 offertes, ensuite paywall.\n");
}

async function main(): Promise<void> {
  try {
    // Pourquoi ce garde : ces simulations valident le paywall. En version
    // Lite (PAYWALL_ENABLED=false), tout le monde est servi : rien à prouver.
    if (!env.PAYWALL_ENABLED) {
      console.error("[test] Simulations paywall : relance avec PAYWALL_ENABLED=true.");
      process.exit(1);
    }
    await testFreeGrant();
    await testUnpaid();
    const paidFrom = await testPaid();
    await testCooldown(paidFrom);
    await testFreeCommands();
    console.log("✅ BOUCLE TELEGRAM FONCTIONNELLE : invitation, preuve+LLM, rejeu, cooldown.\n");
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "[test] Échec.");
    console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

void main();
