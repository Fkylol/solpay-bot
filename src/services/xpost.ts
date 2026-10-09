import { TwitterApi } from "twitter-api-v2";
import { env } from "../config/env.js";

// Poste un tweet via l'endpoint gratuit (~500/mois sur le tier free).
// Pourquoi twitter-api-v2 direct : le plugin Eliza ne poste qu'en réaction
// aux mentions ; ici la publication est volontaire et explicite (--post).
// Jamais appelé en boucle : uniquement depuis le script post-digest.
export async function postTweet(text: string): Promise<string> {
  if (text.length === 0 || text.length > 280) {
    throw new Error("[xpost] Texte invalide (1-280 caractères).");
  }
  const client = new TwitterApi({
    appKey: env.TWITTER_API_KEY ?? "",
    appSecret: env.TWITTER_API_SECRET_KEY ?? env.TWITTER_API_SECRET ?? "",
    accessToken: env.TWITTER_ACCESS_TOKEN ?? "",
    accessSecret: env.TWITTER_ACCESS_TOKEN_SECRET ?? env.TWITTER_ACCESS_SECRET ?? "",
  });
  const { data } = await client.v2.tweet(text);
  return data.id;
}
