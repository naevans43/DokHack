// Card audio from the browser's own speech synthesis -- for cards with no
// captured YouTube clip (most of them: anything mined from a web page). No
// network and no bundled audio: speechSynthesis uses the voices installed on
// the reader's device, so quality varies, and it's labeled as a machine voice.
// Shared by the extension (word popup, library preview) and the website
// (review card, cards page); nothing plays until the reader presses a button.

export function ttsAvailable(): boolean {
  return typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
}

/** A local en-US voice if the device has one, else any English voice, else the default. */
function englishVoice(): SpeechSynthesisVoice | undefined {
  const voices = speechSynthesis.getVoices();
  return voices.find((v) => v.lang === 'en-US' && v.localService)
    ?? voices.find((v) => v.lang === 'en-US')
    ?? voices.find((v) => v.lang.startsWith('en'));
}

/** Stops any card audio that's playing (e.g. when moving to the next card). */
export function stopSpeaking(): void {
  if (ttsAvailable()) speechSynthesis.cancel();
}

/** Speaks `text` in English, cutting off anything already speaking. */
export function speakEnglish(text: string, opts: { rate?: number; onEnd?: () => void } = {}): void {
  if (!ttsAvailable()) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US';
  const voice = englishVoice();
  if (voice) u.voice = voice;
  u.rate = opts.rate ?? 0.9;
  if (opts.onEnd) { u.onend = opts.onEnd; u.onerror = opts.onEnd; }
  speechSynthesis.speak(u);
}

/**
 * "문장 듣기" / "단어 듣기" buttons for a card without its own audio clip, or
 * null when the browser has no speech synthesis. Pressing a playing button
 * stops it.
 */
export function ttsButtons(sentence: string, word: string, buttonClass = 'btn sm'): HTMLElement | null {
  if (!ttsAvailable()) return null;
  const box = document.createElement('div');
  box.className = 'tts';
  const make = (label: string, text: string, rate: number) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = buttonClass;
    b.textContent = label;
    b.addEventListener('click', () => {
      if (b.getAttribute('aria-pressed') === 'true') { speechSynthesis.cancel(); return; }
      box.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
      b.setAttribute('aria-pressed', 'true');
      speakEnglish(text, { rate, onEnd: () => b.setAttribute('aria-pressed', 'false') });
    });
    b.setAttribute('aria-pressed', 'false');
    return b;
  };
  const note = document.createElement('span');
  note.className = 'tts-note';
  note.textContent = '기계 음성';
  box.append(make('문장 듣기', sentence, 0.9), make('단어 듣기', word, 0.8), note);
  return box;
}
