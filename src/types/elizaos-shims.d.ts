// Pourquoi ce shim : @elizaos/plugin-bootstrap 1.7.2 déclare
// "./dist/index.d.ts" dans son package.json mais ne le publie pas
// (seuls index.js + map sont présents). Sans ce fichier, tsc échoue en
// TS7016. On type le minimum utilisé (le plugin bootstrap).
// Note : fichier script global (aucun import top-level) pour que
// `declare module` s'applique à un module non résolu.
declare module "@elizaos/plugin-bootstrap" {
  import type { Plugin } from "@elizaos/core";
  export const bootstrapPlugin: Plugin;
  const _default: Plugin;
  export default _default;
}
