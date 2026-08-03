// Backend API base URL — change this at deploy time.
const API_BASE = "https://kl-erp-buddy-api.onrender.com";

// Cloudflare Turnstile site key for the login checkbox.
// This is Cloudflare's official always-pass TEST key — swap in a real site key
// from the Cloudflare dashboard when going live (and set the matching secret
// on the backend).
const TURNSTILE_SITE_KEY = "0x4AAAAAACvzvtywbMlUWN05";

// Supabase project powering the Plan tab (study blocks / tasks / goals).
// The anon key is safe to ship — rows are scoped to a per-device owner UUID.
const SUPABASE_URL = "https://cptjsunynzzbnbghovlh.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNwdGpzdW55bnp6Ym5iZ2hvdmxoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU3MDkwMTgsImV4cCI6MjEwMTI4NTAxOH0.fIlkysuRiUyL6JC0sesGk39w6sXXLk_ecJSpc-8-1dA";
