import { makeZip, type ZipEntry } from './zip';
import type { MinedCard } from './types';

// "Anki용 내보내기": a zip with a text file Anki can import as-is plus the
// cards' audio clips and video frames. Anki's text import can't carry media
// itself (only the .apkg format can, and writing one needs a SQLite engine),
// so the media files go in a folder the reader copies into Anki's
// collection.media -- the README inside the zip says exactly where.
//
// Uses the built-in "Basic" note type (Front/Back) so it imports with no
// field mapping: Front = the sentence (target word bold) + frame + audio,
// Back = word, meanings, source. The first column is Anki's duplicate key, so
// importing again later updates a card instead of adding a second copy.

export interface MediaSource {
  getBlob(id: string): Promise<{ blob: Blob; mimeType: string } | null>;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Tabs and newlines would break the tab-separated file. */
const oneLine = (s: string) => s.replace(/[\t\r\n]+/g, ' ');

const extensionFor = (mime: string, fallback: string) =>
  mime.includes('webm') ? 'webm' : mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : mime.includes('jpeg') ? 'jpg' : mime.includes('png') ? 'png' : fallback;

export const ANKI_README = `독해크 → Anki 가져오기

1. media 폴더 안의 파일을 모두 Anki의 collection.media 폴더로 복사하세요.
   - Windows: %APPDATA%\\Anki2\\<프로필 이름>\\collection.media
   - Mac: ~/Library/Application Support/Anki2/<프로필 이름>/collection.media
   - Linux: ~/.local/share/Anki2/<프로필 이름>/collection.media
   (Anki에서 도구 → 미디어 확인을 열면 폴더 위치를 알 수 있어요.)
2. Anki에서 파일 → 가져오기를 눌러 dokhack-cards.txt를 고르세요.
   노트 유형은 Basic, 덱은 DokHack으로 자동 설정돼요.
3. 카드를 나중에 다시 가져와도 같은 카드는 중복되지 않고 갱신돼요.

오디오나 영상 화면이 없는 카드는 문장과 뜻만 들어 있어요.
`;

export interface AnkiExportResult {
  blob: Blob;
  cards: number;
  mediaFiles: number;
}

export async function buildAnkiExport(cards: MinedCard[], source: MediaSource): Promise<AnkiExportResult> {
  const enc = new TextEncoder();
  const entries: ZipEntry[] = [];
  const lines = [
    '#separator:tab',
    '#html:true',
    '#guid column:1',
    '#notetype:Basic',
    '#deck:DokHack',
    '#columns:Guid\tFront\tBack',
  ];
  let mediaFiles = 0;

  for (const c of cards) {
    const sentence = `${escapeHtml(c.sentence.slice(0, c.targetStart))}<b>${escapeHtml(c.sentence.slice(c.targetStart, c.targetStart + c.surface.length))}</b>${escapeHtml(c.sentence.slice(c.targetStart + c.surface.length))}`;
    const front = [sentence];

    for (const [blobId, kind] of [[c.frameBlobId, 'frame'], [c.audioBlobId, 'audio']] as const) {
      if (!blobId) continue;
      const stored = await source.getBlob(blobId).catch(() => null);
      if (!stored) continue;
      const name = `dokhack-${c.id.slice(0, 8)}-${kind}.${extensionFor(stored.mimeType, kind === 'audio' ? 'webm' : 'jpg')}`;
      entries.push({ name: `media/${name}`, data: new Uint8Array(await stored.blob.arrayBuffer()) });
      mediaFiles++;
      front.push(kind === 'frame' ? `<img src="${name}">` : `[sound:${name}]`);
    }

    const meanings = c.definitions.map((d) => escapeHtml(d.text)).join('<br>');
    const back = [`<b>${escapeHtml(c.lemma)}</b>`, meanings, c.url ? `<small>${escapeHtml(c.url)}</small>` : ''].filter(Boolean).join('<br>');
    lines.push([`dokhack-${c.id}`, front.join('<br>'), back].map(oneLine).join('\t'));
  }

  entries.unshift(
    { name: 'dokhack-cards.txt', data: enc.encode(lines.join('\n') + '\n') },
    { name: 'README.txt', data: enc.encode(ANKI_README) },
  );
  return { blob: makeZip(entries), cards: cards.length, mediaFiles };
}
