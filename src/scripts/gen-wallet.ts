// Génère un wallet Devnet persistant et l'enregistre dans .env.
// Usage : npm run gen-wallet
// Affiche l'adresse à financer sur https://faucet.solana.com (gratuit).
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Pourquoi écrire dans .env : un wallet de test n'a de valeur que s'il est
// réutilisé entre les exécutions (sinon chaque run repart d'une adresse vide
// impossible à financer). .env est gitignoré, la clé n'est jamais logguée.
async function main(): Promise<void> {
  const keypair = Keypair.generate();
  const secret = bs58.encode(keypair.secretKey);
  const address = keypair.publicKey.toBase58();

  const envPath = join(process.cwd(), ".env");
  const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const line = `SOLANA_PRIVATE_KEY=${secret}`;
  const next = /^SOLANA_PRIVATE_KEY=.*$/m.test(current)
    ? current.replace(/^SOLANA_PRIVATE_KEY=.*$/m, line)
    : `${current}${current === "" || current.endsWith("\n") ? "" : "\n"}${line}\n`;
  writeFileSync(envPath, next, "utf8");

  console.log(`\nAdresse publique : ${address}`);
  console.log("1. Finance-la sur https://faucet.solana.com (réseau Devnet, gratuit).");
  console.log("2. Relance : npm run test:solana");
  console.log(".env mis à jour (SOLANA_PRIVATE_KEY). Ne le committe jamais.\n");
}

void main();
