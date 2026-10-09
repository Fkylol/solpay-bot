// Digest marché pour X (endpoint de publication gratuit).
// Usage :
//   npm run digest              -> affiche le texte, NE PUBLIE RIEN
//   npm run digest -- --post    -> publie vraiment (compte gratuit X)
import { buildDigest } from "../services/digest.js";
import { postTweet } from "../services/xpost.js";
import { logger } from "../utils/logger.js";

async function main(): Promise<void> {
  try {
    const text = await buildDigest();
    console.log(`\n----- DIGEST (${text.length} caractères) -----\n${text}\n------------------------------------\n`);
    if (!process.argv.includes("--post")) {
      console.log("Aucune publication (mode aperçu). Relance avec --post pour publier sur X.");
      return;
    }
    const id = await postTweet(text);
    console.log(`Publié sur X, tweet id : ${id}`);
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "[digest] Échec.");
    console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

void main();
