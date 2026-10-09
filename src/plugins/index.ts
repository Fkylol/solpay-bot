// Point d'extension pour les futurs plugins métier (bloc 2+ : blockchain, paiement...).
// Pourquoi un tableau vide : le runtime charge déjà sql/openai/bootstrap/twitter
// depuis src/index.ts, ce fichier reste le tiroir des plugins custom.
import type { Plugin } from "@elizaos/core";

export const customPlugins: Plugin[] = [];
