/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __URL_FULL__: string;
declare const __URL_TECH__: string;
declare const __URL_FINANCE__: string;
declare const __URL_HAPPY__: string;

interface ImportMetaEnv {
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_WS_API_URL?: string;
  readonly VITE_RELAY_HTTP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
