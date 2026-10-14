import { getSession, requestLoginCode, verifyLoginCode } from './supabase';

if (getSession()) location.href = 'index.html';

const emailInput = document.getElementById('email') as HTMLInputElement;
const codeRow = document.getElementById('codeRow')!;
const codeInput = document.getElementById('code') as HTMLInputElement;
const error = document.getElementById('error')!;
const requestBtn = document.getElementById('requestCode') as HTMLButtonElement;
const verifyBtn = document.getElementById('verifyCode') as HTMLButtonElement;

function showError(message: string): void {
  error.textContent = message;
  error.hidden = false;
}

requestBtn.addEventListener('click', async () => {
  const email = emailInput.value.trim();
  if (!email) return;
  error.hidden = true;
  requestBtn.disabled = true;
  try {
    await requestLoginCode(email);
    codeRow.hidden = false;
    codeInput.focus();
  } catch {
    showError('코드를 보내지 못했습니다. 잠시 후 다시 시도하세요.');
  } finally {
    requestBtn.disabled = false;
  }
});

verifyBtn.addEventListener('click', async () => {
  const email = emailInput.value.trim();
  const code = codeInput.value.trim();
  if (!email || !code) return;
  error.hidden = true;
  verifyBtn.disabled = true;
  try {
    await verifyLoginCode(email, code);
    location.href = 'index.html';
  } catch {
    showError('코드가 올바르지 않습니다. 다시 확인해 주세요.');
    verifyBtn.disabled = false;
  }
});
