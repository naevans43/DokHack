import { renderNav } from './nav';
import { getSession } from './supabase';

// The start page is public (no requireSession) -- it's what a new tester opens
// before they have an account. renderNav shows a guest nav when signed out.
renderNav('start');

// The "복습 사이트 시작" button means "sign in" for a visitor and "go home" for
// someone already signed in.
const cta = document.getElementById('goReview') as HTMLAnchorElement | null;
if (cta && getSession()) {
  cta.href = 'index.html';
  cta.textContent = '홈으로 가기';
}
