// Backend API base URL — change this at deploy time.
const API_BASE = "https://kl-erp-buddy-api.onrender.com";

// Cloudflare Turnstile site key for the login checkbox.
// This is Cloudflare's official always-pass TEST key — swap in a real site key
// from the Cloudflare dashboard when going live (and set the matching secret
// on the backend).
const TURNSTILE_SITE_KEY = "1x00000000000000000000AA";
