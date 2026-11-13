/** Config keys whose values must never be rendered. Server redacts these,
 *  but the UI masks them too so a backend regression cannot leak secrets. */
export const SECRET_KEYS = new Set([
    "api_key",
    "apikey",
    "secret",
    "token",
    "password",
    "authorization",
]);
export function maskSecrets(config) {
    const out = {};
    for (const [key, value] of Object.entries(config)) {
        out[key] = SECRET_KEYS.has(key.toLowerCase()) ? "••••••••" : value;
    }
    return out;
}
