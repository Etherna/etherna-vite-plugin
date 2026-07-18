/** Vite cache dir the SSL certificate is written under (relative to cwd). */
export const DEFAULT_CACHE_DIR = "node_modules/.vite"

/** Default dev-server port used as fallback when the listening port is unknown. */
export const DEFAULT_APP_PORT = 5173
/** Default dev-server port used as fallback when HTTPS is requested. */
export const DEFAULT_APP_HTTPS_PORT = 5371

export const CERTIFICATE_DIR = ".ssl"
export const CERTIFICATE_CERT_NAME = "etherna.crt"
export const CERTIFICATE_KEY_NAME = "etherna.key"
export const CERTIFICATE_PFX_NAME = "etherna.pfx"
export const CERTIFICATE_PASSWORD = ""
