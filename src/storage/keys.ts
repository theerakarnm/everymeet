/**
 * R2 object keys. Kept free of imports so the meet-recorder Worker (meet/worker) can bundle it too.
 */
export const keys = {
  manifest: (id: string) => `meetings/${id}/manifest.json`,
  segment: (id: string, userId: string, index: number) =>
    `meetings/${id}/segments/${userId}/${String(index).padStart(4, "0")}.flac`,
  track: (id: string, userId: string) => `meetings/${id}/tracks/${userId}.ogg`,
  mixed: (id: string) => `meetings/${id}/meeting.mp3`,
  transcript: (id: string) => `meetings/${id}/transcript.txt`,
  summaryFull: (id: string) => `meetings/${id}/summary-full.md`,
  summaryShort: (id: string) => `meetings/${id}/summary-short.md`,
  /** Screenshot the Google Meet recorder saves when it cannot join. */
  debug: (id: string, name: string) => `meetings/${id}/debug/${name}`,
};
