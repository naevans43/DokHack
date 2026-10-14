import { SUPABASE_ANON_KEY, SUPABASE_URL } from './config';

// Email OTP session handling, mirroring extension/src/background.ts's account
// functions. Signing in here is independent from signing in in the
// extension — both just authenticate the same Supabase account, so a card
// synced from either side lands in the same row set.

export interface Session {
  email: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

const STORAGE_KEY = 'dokhack-session';
const headers = { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY };

export function getSession(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function setSession(session: Session | null): void {
  if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  else localStorage.removeItem(STORAGE_KEY);
}

export async function requestLoginCode(email: string): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/otp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, create_user: true }),
  });
  if (!res.ok) throw new Error(`otp-${res.status}`);
}

export async function verifyLoginCode(email: string, code: string): Promise<Session> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ type: 'email', email, token: code }),
  });
  if (!res.ok) throw new Error(`verify-${res.status}`);
  const data = await res.json();
  const session: Session = {
    email,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  setSession(session);
  return session;
}

export function logout(): void {
  setSession(null);
}

async function refreshSession(session: Session): Promise<Session> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ refresh_token: session.refreshToken }),
  });
  if (!res.ok) {
    setSession(null);
    throw new Error(`refresh-${res.status}`);
  }
  const data = await res.json();
  const next: Session = {
    email: session.email,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? session.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  setSession(next);
  return next;
}

/** The current session, refreshed first if it's about to expire. Null if signed out. */
export async function ensureFreshSession(): Promise<Session | null> {
  const session = getSession();
  if (!session) return null;
  return session.expiresAt < Date.now() + 30_000 ? refreshSession(session) : session;
}

/** A fetch to the Supabase REST API, authorized as the signed-in user. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const session = await ensureFreshSession();
  if (!session) throw new Error('not-signed-in');
  return fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: { ...headers, ...init.headers, Authorization: `Bearer ${session.accessToken}` },
  });
}
