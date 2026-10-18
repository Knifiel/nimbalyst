/**
 * One lightbox for every image in a transcript: user attachments, editor
 * screenshots and display_to_user images. Opening any of them lets the user
 * step through the rest with the arrow keys or the Prev/Next buttons.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TranscriptViewMessage } from '../../../ai/server/transcript/TranscriptProjector';
import { FullscreenModal } from './FullscreenModal';
import { ZoomableImageSurface } from './ZoomableImageSurface';
import { TranscriptImageGalleryContext, type TranscriptImageGalleryApi } from './transcriptImageGalleryContext';
import { useEditorScreenshotImage } from './CustomToolWidgets/editorScreenshotImage';
import { useImageSource } from './CustomToolWidgets/displayImageSource';
import { attachmentImageSrc, collectTranscriptImages, type TranscriptImage } from '../utils/transcriptImages';

type ReadFile = (path: string) => Promise<{ success: boolean; content?: string; error?: string }>;

const BUTTON_CLASS = 'rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] px-2 py-1 text-xs text-[var(--nim-text)] transition-colors duration-150 hover:bg-[var(--nim-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50';

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}

interface SlideProps {
  toolbarLabel: React.ReactNode;
  toolbarExtras: React.ReactNode;
}

const Slide: React.FC<SlideProps & { src: string | null; alt: string; copyFilePath?: string; status?: string }> = ({
  src, alt, copyFilePath, status, toolbarLabel, toolbarExtras,
}) => {
  if (src) {
    return <ZoomableImageSurface src={src} alt={alt} copyFilePath={copyFilePath} toolbarLabel={toolbarLabel} toolbarExtras={toolbarExtras} />;
  }
  return (
    <div className="flex h-full flex-col bg-[var(--nim-bg)]">
      <div className="flex items-center gap-2 border-b border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-3 py-2">
        <div className="min-w-0 flex-1 text-sm text-[var(--nim-text-muted)]">{toolbarLabel}</div>
        <div className="flex shrink-0 items-center gap-2">{toolbarExtras}</div>
      </div>
      <div className="flex flex-1 items-center justify-center text-sm text-[var(--nim-text-muted)]">{status}</div>
    </div>
  );
};

const ScreenshotSlide: React.FC<SlideProps & { image: Extract<TranscriptImage, { kind: 'screenshot' }>; readFile?: ReadFile }> = ({ image, readFile, ...chrome }) => {
  const { imageSrc, loading, persistedLoadError } = useEditorScreenshotImage(image.message, readFile);
  return <Slide {...chrome} src={imageSrc} alt={image.label} status={loading ? 'Loading...' : persistedLoadError ?? 'No image'} />;
};

const DisplaySlide: React.FC<SlideProps & { image: Extract<TranscriptImage, { kind: 'display' }>; readFile?: ReadFile }> = ({ image, readFile, ...chrome }) => {
  const { imageData, loading, error } = useImageSource(image.image, readFile);
  return <Slide {...chrome} src={imageData} alt={image.label} copyFilePath={image.image.path} status={loading ? 'Loading...' : error ?? 'No image'} />;
};

function renderSlide(image: TranscriptImage, readFile: ReadFile | undefined, chrome: SlideProps) {
  switch (image.kind) {
    case 'attachment': {
      const filepath = image.attachment.filepath;
      const copyFilePath = filepath && !filepath.startsWith('data:') ? filepath.replace(/^file:\/\//, '') : undefined;
      return <Slide {...chrome} src={attachmentImageSrc(image.attachment) || null} alt={image.label} copyFilePath={copyFilePath} status="No image" />;
    }
    case 'screenshot':
      return <ScreenshotSlide {...chrome} image={image} readFile={readFile} />;
    case 'display':
      return <DisplaySlide {...chrome} image={image} readFile={readFile} />;
  }
}

export const TranscriptImageGalleryProvider: React.FC<{
  messages: TranscriptViewMessage[];
  readFile?: ReadFile;
  children: React.ReactNode;
}> = ({ messages, readFile, children }) => {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const api = useMemo<TranscriptImageGalleryApi>(() => ({
    openImage: (key) => {
      if (!collectTranscriptImages(messagesRef.current).some(image => image.key === key)) return false;
      setOpenKey(key);
      return true;
    },
  }), []);

  // Only walk the transcript while the lightbox is open; new images streaming
  // in extend the sequence without moving the one on screen.
  const isOpen = openKey !== null;
  const images = useMemo(() => (isOpen ? collectTranscriptImages(messages) : []), [isOpen, messages]);
  const index = isOpen ? images.findIndex(image => image.key === openKey) : -1;
  const close = useCallback(() => setOpenKey(null), []);

  useEffect(() => {
    if (isOpen && index === -1) setOpenKey(null);
  }, [isOpen, index]);

  const go = useCallback((delta: number) => {
    const next = images[index + delta];
    if (next) setOpenKey(next.key);
  }, [images, index]);

  useEffect(() => {
    if (index === -1) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || isEditableTarget(e.target)) return;
      // The lightbox is modal: keep the arrow from also scrolling or reaching
      // app-level handlers behind it.
      e.preventDefault();
      e.stopPropagation();
      go(e.key === 'ArrowLeft' ? -1 : 1);
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [index, go]);

  const current = index === -1 ? null : images[index];

  return (
    <TranscriptImageGalleryContext.Provider value={api}>
      {children}
      {current && (
        <FullscreenModal
          isOpen
          onClose={close}
          ariaLabel="Image preview"
          contentClassName="transcript-image-lightbox h-[92dvh] w-[96vw] max-w-[1400px] overflow-hidden rounded-lg border border-nim bg-nim shadow-2xl"
        >
          <React.Fragment key={current.key}>
            {renderSlide(current, readFile, {
              toolbarLabel: (
                <div className="min-w-0 truncate font-mono text-sm text-nim" title={current.label}>
                  {current.label}
                </div>
              ),
              toolbarExtras: (
                <>
                  {images.length > 1 ? (
                    <div className="flex items-center gap-1">
                      <button type="button" className={BUTTON_CLASS} onClick={() => go(-1)} disabled={index === 0} aria-label="Previous image" title="Previous image (Left arrow)">
                        Prev
                      </button>
                      <div className="min-w-[3.5rem] text-center font-mono text-xs text-[var(--nim-text-muted)]" data-testid="transcript-image-position">
                        {index + 1} / {images.length}
                      </div>
                      <button type="button" className={BUTTON_CLASS} onClick={() => go(1)} disabled={index === images.length - 1} aria-label="Next image" title="Next image (Right arrow)">
                        Next
                      </button>
                    </div>
                  ) : null}
                  <button type="button" className={BUTTON_CLASS} onClick={close} aria-label="Close (Escape)" title="Close (Escape)">
                    Close
                  </button>
                </>
              ),
            })}
          </React.Fragment>
        </FullscreenModal>
      )}
    </TranscriptImageGalleryContext.Provider>
  );
};
