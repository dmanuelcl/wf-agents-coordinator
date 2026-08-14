/**
 * The alert tones, synthesized rather than shipped as audio files: a chime is a
 * few sine partials, and generating it keeps the bundle free of binary assets
 * and works with no network.
 */
export interface AlertChime {
  /** Play once. Resolves immediately; the sound is fire-and-forget. */
  play(tone: "attention" | "done"): void;
  close(): void;
}

// Descending minor third reads as "something needs you"; ascending perfect
// fourth reads as "finished". Kept short so a repeating alert is not punishing.
const TONES = {
  attention: [880, 740],
  done: [660, 880],
} as const;

export function createAlertChime(context: AudioContext): AlertChime {
  return {
    play(tone) {
      // A tab that has never been interacted with leaves the context suspended;
      // browsers only allow audio after a gesture. Asking to resume is
      // harmless when it is already running.
      void context.resume().catch(() => {});
      const now = context.currentTime;
      TONES[tone].forEach((frequency, index) => {
        const at = now + index * 0.18;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = frequency;
        // Ramps rather than steps: a square-edged envelope clicks.
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.18, at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.17);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(at);
        oscillator.stop(at + 0.18);
      });
    },
    close() {
      void context.close().catch(() => {});
    },
  };
}
