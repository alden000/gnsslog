// Build-time presets for a private Android build. Empty in the repository: tools/build-www.mjs
// replaces this file in www/ with the values from the JSON file named by GNSSLOG_PRESET_FILE,
// e.g. { "endpoint": "https://…/ingest", "authHeader": "Authorization", "authValue": "Bearer …" }.
// Tokens must never be committed here.
export const PRESET = {};
