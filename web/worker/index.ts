import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../src/config';

// The site itself is static assets (wrangler.toml [assets]); this script only
// exists for the daily cron in wrangler.toml. Supabase's free plan pauses a
// project after about a week without activity, and a real database query is
// what counts — so once a day we ask PostgREST for one card id. With the anon
// key and no session, row-level security returns an empty list, but Postgres
// still runs the query.

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

export default {
  // Assets are matched before the script runs, so this only sees requests
  // with no matching file; hand them back to the assets layer for its 404.
  fetch(request: Request, env: Env): Promise<Response> {
    return env.ASSETS.fetch(request);
  },

  async scheduled(): Promise<void> {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/cards?select=id&limit=1`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    });
    if (!res.ok) throw new Error(`Supabase keep-alive failed: ${res.status} ${await res.text()}`);
  },
};
