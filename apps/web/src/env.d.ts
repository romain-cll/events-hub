/// <reference types="vite/client" />

/**
 * Variables d'environnement exposées au client par Vite.
 *
 * Sans cette déclaration, `import.meta.env.VITE_API_URL` est typé `any` : le
 * lint type-aware le signale, et surtout une faute de frappe passerait sans
 * bruit jusqu'à un `fetch(undefined)` à l'exécution.
 */
interface ImportMetaEnv {
  /** Base de l'API d'ingestion et de lecture. Défaut : `http://localhost:3003`. */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
