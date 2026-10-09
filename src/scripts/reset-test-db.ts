// Remet à zéro la base de test AVANT les simulations (jamais la prod).
// Pourquoi : les sims écrivent (paiements, liens, tickets gratuits plafonnés
// à 10). Sans reset, un 2e run hérite du 1er et devient non déterministe.
// Ne touche que PAYMENTS_DB_PATH (défaut : data/payments-test.db).
import { rmSync } from "node:fs";

const target = process.env.PAYMENTS_DB_PATH ?? "data/payments-test.db";
for (const suffix of ["", "-shm", "-wal", "-journal"]) {
  rmSync(`${target}${suffix}`, { force: true });
}
console.log(`[test] Base de test réinitialisée : ${target}`);
