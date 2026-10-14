// Binary <-> base64 for crossing chrome.runtime.sendMessage. Chrome
// serializes extension messages as JSON, which turns an ArrayBuffer or Blob
// into `{}` -- a captured audio clip sent that way would arrive as an empty
// object and be stored as nothing. A base64 string survives any
// serialization, at the cost of ~33% size on a transfer that's a few hundred
// KB at most.

export function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000; // String.fromCharCode's argument limit
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
