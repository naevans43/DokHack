// IndexedDB-backed store for captured YouTube audio-clip/frame blobs
// (roadmap item 11). Lives in the background worker, not a content script,
// because a content script's own indexedDB.open() is scoped to the PAGE's
// origin (e.g. youtube.com), not the extension's -- only this worker's own
// JS realm opens IndexedDB at the correct chrome-extension://<id> origin.
// Blobs are handed here over chrome.runtime.sendMessage as ArrayBuffers
// (see types.ts's storeBlob/getBlob/deleteBlob requests, background.ts's
// handlers).

const DB_NAME = 'dokhack-blobs';
const DB_VERSION = 1;
const STORE_NAME = 'blobs';

export interface StoredBlob {
  id: string;
  kind: 'audio' | 'frame';
  mimeType: string;
  blob: Blob;
  createdAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE_NAME)) req.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('indexeddb-open-failed'));
    });
  }
  return dbPromise;
}

export async function putBlob(kind: 'audio' | 'frame', mimeType: string, data: ArrayBuffer): Promise<string> {
  const db = await openDb();
  const id = crypto.randomUUID();
  const record: StoredBlob = { id, kind, mimeType, blob: new Blob([data], { type: mimeType }), createdAt: Date.now() };
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('indexeddb-put-failed'));
  });
  return id;
}

export async function getBlob(id: string): Promise<StoredBlob | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id);
    req.onsuccess = () => resolve((req.result as StoredBlob) ?? null);
    req.onerror = () => reject(req.error ?? new Error('indexeddb-get-failed'));
  });
}

export async function deleteBlob(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('indexeddb-delete-failed'));
  });
}
