import { ttsButtons } from '../../extension/src/tts';
import { mediaUrl, type CardRow } from './cards-api';

/**
 * The card's video frame and audio clip (captured in the extension from a
 * YouTube transcript line). A card with no clip gets browser speech buttons
 * instead (tts.ts); null only when there's neither. The files load
 * asynchronously -- they sit behind the reader's login -- so the elements
 * appear as they arrive, and a failure shows a short note instead of a broken
 * image or a dead player.
 */
export function mediaBlock(c: Pick<CardRow, 'audio_path' | 'frame_path' | 'sentence' | 'lemma'>): HTMLElement | null {
  const tts = c.audio_path ? null : ttsButtons(c.sentence, c.lemma);
  if (!c.frame_path && !c.audio_path && !tts) return null;
  const box = document.createElement('div');
  box.className = 'media';

  const note = document.createElement('p');
  note.className = 'media-note muted';
  note.hidden = true;
  const fail = () => {
    note.textContent = '영상 화면이나 오디오를 불러오지 못했어요.';
    note.hidden = false;
  };

  if (c.frame_path) {
    const img = document.createElement('img');
    img.className = 'frame';
    img.alt = '영상 화면';
    img.hidden = true;
    box.append(img);
    mediaUrl(c.frame_path).then((url) => {
      if (url) { img.src = url; img.hidden = false; } else fail();
    });
  }
  if (c.audio_path) {
    const audio = document.createElement('audio');
    audio.className = 'clip';
    audio.controls = true;
    audio.preload = 'metadata';
    audio.hidden = true;
    box.append(audio);
    mediaUrl(c.audio_path).then((url) => {
      if (url) { audio.src = url; audio.hidden = false; } else fail();
    });
  }
  if (tts) box.append(tts);
  box.append(note);
  return box;
}
