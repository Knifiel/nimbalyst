import { createContext, useContext } from 'react';

export interface TranscriptImageGalleryApi {
  /**
   * Open the transcript-wide lightbox at the image with this key (see
   * `utils/transcriptImages`). Returns false when the key is not part of the
   * transcript, so the caller can fall back to its own preview.
   */
  openImage: (key: string) => boolean;
}

export const TranscriptImageGalleryContext = createContext<TranscriptImageGalleryApi | null>(null);

/** Null outside a transcript (standalone widget renders). */
export function useTranscriptImageGallery(): TranscriptImageGalleryApi | null {
  return useContext(TranscriptImageGalleryContext);
}
