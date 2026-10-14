// Fill these in after creating the Supabase project (see /web/README.md and
// CLAUDE.md's roadmap notes). The anon key is safe to ship client-side —
// row-level security on the `cards` table is what actually protects each
// user's data, not secrecy of this key.
export const SUPABASE_URL = 'https://ulanrdugzsftblaluaed.supabase.co';
export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVsYW5yZHVnenNmdGJsYWx1YWVkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkyOTM4NTcsImV4cCI6MjEwNDg2OTg1N30.1UEOSH3Zd461xs3oEAtDFiGh04VtUp9kDroE97qt3Hg';

// The companion review website (../web), deployed via `npx wrangler deploy`
// there. Update this if the Cloudflare Workers subdomain or a custom domain
// ever changes — see ../web/README.md.
export const REVIEW_SITE_URL = 'https://dokhack-review.dokhack.workers.dev';
