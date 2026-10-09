// Script de test Bloc 2 (Devnet, gratuit, aucun argent réel).
// Usage :
//   npm run test:solana                        -> test complet automatique
//   npm run test:solana -- <signature> <payer> [montantSol] -> vérifie un paiement donné
import {
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  type PublicKey,
} from "@solana/web3.js";
import { env } from "../config/env.js";
import { getConnection, solanaHealthcheck } from "../solana/connection.js";
import { getAgentBalance, getAgentPublicKey, sendSolFromAgent } from "../solana/wallet.js";
import { hasActiveAccess, verifyPayment } from "../solana/payments.js";
import { logger } from "../utils/logger.js";

function fmtSol(lamports: number): string {
  return `${lamports / LAMPORTS_PER_SOL} SOL`;
}

// Pourquoi cette confirmation explicite : requestAirdrop renvoie vite, mais
// les fonds ne sont utilisables qu'après confirmation du bloc.
async function confirmSignature(signature: string): Promise<void> {
  const connection = getConnection();
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
}

// Remplit un wallet en Devnet (airdrop gratuit). Refuse hors devnet.
// Avec retries car le faucet public est souvent en rate-limit.
// Si `required` est faux, un échec n'est qu'un avertissement (ex. le wallet
// agent n'a besoin d'aucun fonds pour recevoir un paiement).
async function airdropDevnet(
  pubkey: PublicKey,
  sol: number,
  label: string,
  required = true,
): Promise<void> {
  if (env.SOLANA_NETWORK !== "devnet") {
    throw new Error(`[test] Airdrop réservé au devnet (réseau actuel : ${env.SOLANA_NETWORK}).`);
  }
  const connection = getConnection();
  const balance = await connection.getBalance(pubkey);
  if (balance >= Math.round(sol * LAMPORTS_PER_SOL)) {
    console.log(`[test] ${label} déjà financé : ${fmtSol(balance)}.`);
    return;
  }
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`[test] Airdrop ${sol} SOL vers ${label} (${pubkey.toBase58()}) [tentative ${attempt}/3]...`);
      const sig = await connection.requestAirdrop(pubkey, Math.round(sol * LAMPORTS_PER_SOL));
      await confirmSignature(sig);
      console.log(`[test] Airdrop confirmé : ${fmtSol(await connection.getBalance(pubkey))}.`);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      logger.warn(`[test] Airdrop ${label} tentative ${attempt} : ${lastError}`);
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }
  const message = `[test] Airdrop ${label} impossible après 3 tentatives (faucet devnet saturé ?) : ${lastError}`;
  if (required) throw new Error(message);
  logger.warn(`${message} — on continue sans (réception possible avec solde nul).`);
}

// Mode vérification manuelle : npm run test:solana -- <signature> <payer> [montant]
async function runVerifyMode(signature: string, payer: string, amountArg?: string): Promise<void> {
  const amount = amountArg !== undefined ? Number(amountArg) : env.PAYMENT_PRICE_SOL;
  console.log(`[test] Vérification : signature=${signature} payeur=${payer} attendu=${amount} SOL`);
  const result = await verifyPayment(signature, amount, payer);
  console.log(JSON.stringify(result, null, 2));
  console.log(`[test] hasActiveAccess(${payer}) = ${hasActiveAccess(payer)}`);
  if (!result.ok) process.exit(1);
}

// Mode automatique : payeur jetable financé par airdrop -> transfert du prix
// vers l'agent -> verifyPayment OK -> rejeu refusé -> accès actif.
async function runSelfTest(): Promise<void> {
  const connection = getConnection();
  const version = await solanaHealthcheck();
  console.log(`[test] RPC OK (${env.SOLANA_RPC_URL}) — solana-core ${version}`);

  const agent = getAgentPublicKey();
  console.log(`[test] Wallet agent : ${agent.toBase58()}`);
  let agentBalance = await getAgentBalance();
  console.log(`[test] Solde agent : ${agentBalance} SOL`);
  if (agentBalance === 0) {
    // Pourquoi non bloquant : l'agent ne fait que recevoir dans ce test.
    await airdropDevnet(agent, 1, "agent", false);
    agentBalance = await getAgentBalance();
  }

  const price = env.PAYMENT_PRICE_SOL;
  const payer = Keypair.generate();
  console.log(`[test] Wallet payeur (jetable) : ${payer.publicKey.toBase58()}`);
  await airdropDevnet(payer.publicKey, 1, "payeur", false);

  // Pourquoi ce repli : le faucet RPC public est souvent saturé (429). Si le
  // payeur reste vide mais que l'agent est financé (via faucet.solana.com),
  // l'agent avance les fonds du test. Sinon, message d'action explicite.
  const needed = price + 0.01; // paiement + marge de frais
  let payerBalance =
    (await connection.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL;
  if (payerBalance < needed) {
    agentBalance = await getAgentBalance();
    if (agentBalance < needed + 0.01) {
      throw new Error(
        `[test] Fonds insuffisants et faucet saturé. Envoie des SOL de test à ${agent.toBase58()} via https://faucet.solana.com (Devnet) puis relance.`,
      );
    }
    console.log(`[test] Faucet saturé : l'agent avance ${needed} SOL au payeur...`);
    await sendSolFromAgent(payer.publicKey, Math.round(needed * LAMPORTS_PER_SOL));
    payerBalance = (await connection.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL;
    console.log(`[test] Payeur financé par l'agent : ${payerBalance} SOL.`);
  }

  console.log(`[test] Transfert ${price} SOL payeur -> agent...`);
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
  console.log(`[test] Transaction confirmée : ${signature}`);

  const first = await verifyPayment(signature, price, payer.publicKey.toBase58());
  console.log(`[test] verifyPayment #1 : ${JSON.stringify(first)}`);
  if (!first.ok) throw new Error("[test] ÉCHEC : paiement légitime refusé.");

  const second = await verifyPayment(signature, price, payer.publicKey.toBase58());
  console.log(`[test] verifyPayment #2 (rejeu) : ${JSON.stringify(second)}`);
  if (second.ok || second.reason !== "already-used") {
    throw new Error("[test] ÉCHEC : rejeu non détecté.");
  }

  const access = hasActiveAccess(payer.publicKey.toBase58());
  console.log(`[test] hasActiveAccess(payeur) = ${access}`);
  if (!access) throw new Error("[test] ÉCHEC : accès non accordé après paiement.");

  console.log(`[test] Nouveau solde agent : ${await getAgentBalance()} SOL`);
  console.log("\n✅ BLOC 2 FONCTIONNEL : connexion, wallet, paiement, anti-rejeu, accès.\n");
}

async function main(): Promise<void> {
  try {
    const [, , signature, payer, amount] = process.argv;
    if (signature && payer) {
      await runVerifyMode(signature, payer, amount);
    } else if (signature || payer) {
      console.error("[test] Usage : npm run test:solana -- <signature> <adressePayeur> [montantSol]");
      process.exit(1);
    } else {
      await runSelfTest();
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "[test] Échec.");
    console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

void main();
