/**
 * Image resolution for capture_editor_screenshot results, shared by the inline
 * widget and the transcript image lightbox.
 *
 * Handles both inline base64 images and persisted-output files
 * (when Claude Code saves large outputs to files).
 */

import { useState, useEffect, useMemo } from 'react';
import type { TranscriptViewMessage } from '../../../../ai/server/transcript/TranscriptProjector';
import { parseToolResult } from '../../../../ai/server/transcript/toolResultParser';

type ReadFile = (path: string) => Promise<{ success: boolean; content?: string; error?: string }>;
type ImageData = { imageBase64: string; mimeType: string };

function imageFromBlocks(blocks: any[]): ImageData | null {
  for (const block of blocks) {
    // New MCP format: { type: 'image', source: { type: 'base64', data: '...', media_type: '...' } }
    if (block?.type === 'image' && block.source?.data) {
      return { imageBase64: block.source.data, mimeType: block.source.media_type || 'image/png' };
    }
    // Old format: { type: 'image', data: '...', mimeType: '...' }
    if (block?.type === 'image' && block.data) {
      return { imageBase64: block.data, mimeType: block.mimeType || 'image/png' };
    }
  }
  return null;
}

function textBlocks(result: any): string[] {
  if (typeof result === 'string') return [result];
  const blocks = Array.isArray(result) ? result : Array.isArray(result?.content) ? result.content : [];
  return blocks
    .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: any) => block.text as string);
}

/** The MCP format returns: { type: 'image', source: { type: 'base64', data: '...', media_type: 'image/png' } } */
function extractImageData(result: any): ImageData | null {
  if (!result) return null;
  if (Array.isArray(result)) return imageFromBlocks(result);
  if (Array.isArray(result.content)) return imageFromBlocks(result.content);
  if (result.imageBase64) {
    return { imageBase64: result.imageBase64, mimeType: result.mimeType || 'image/png' };
  }
  return null;
}

/**
 * Claude Code saves large outputs to files with this format:
 * <persisted-output>Output too large (2MB). Full output saved to: /path/to/file</persisted-output>
 */
function extractPersistedFilePath(result: any): string | null {
  for (const text of textBlocks(result)) {
    if (!text.includes('<persisted-output>')) continue;
    const match = text.match(/<persisted-output>[^]*?Full output saved to:\s*([^\s<]+)/);
    if (match) return match[1];
  }
  return null;
}

/** Parse image data from a persisted output file's JSON content */
function parsePersistedImageData(fileContent: string): ImageData | null {
  try {
    const parsed = JSON.parse(fileContent);
    // The file contains an array of MCP content blocks
    const blocks = Array.isArray(parsed) ? parsed : parsed?.content;
    return Array.isArray(blocks) ? imageFromBlocks(blocks) : null;
  } catch {
    return null;
  }
}

export function useEditorScreenshotImage(message: TranscriptViewMessage, readFile?: ReadFile) {
  const [loadingPersistedFile, setLoadingPersistedFile] = useState(false);
  const [persistedImageData, setPersistedImageData] = useState<ImageData | null>(null);
  const [persistedLoadError, setPersistedLoadError] = useState<string | null>(null);

  // Canonical transcript stores tool results as strings -- JSON-stringified for
  // MCP content arrays (including image blocks). The result can be ~700 KB of
  // base64, so parse and build the data URL only when it changes, not on every
  // transcript render.
  const tool = message.toolCall;
  const hasTool = !!tool;
  const toolResult = tool?.result;
  const parsedResult = useMemo(() => (hasTool ? parseToolResult(toolResult) : undefined), [hasTool, toolResult]);
  const persistedFilePath = useMemo(() => (parsedResult ? extractPersistedFilePath(parsedResult) : null), [parsedResult]);

  useEffect(() => {
    if (!persistedFilePath) return;
    if (!readFile) {
      setPersistedLoadError('File reading not available');
      return;
    }

    const loadPersistedFile = async () => {
      setLoadingPersistedFile(true);
      setPersistedLoadError(null);
      try {
        const result = await readFile(persistedFilePath);
        if (!result.success || !result.content) {
          throw new Error(result.error || 'Failed to read file');
        }
        const imageData = parsePersistedImageData(result.content);
        if (!imageData) {
          throw new Error('Could not parse image data from file');
        }
        setPersistedImageData(imageData);
      } catch (err) {
        setPersistedLoadError(err instanceof Error ? err.message : 'Failed to load image');
      } finally {
        setLoadingPersistedFile(false);
      }
    };

    loadPersistedFile();
  }, [persistedFilePath, readFile]);

  const inlineImageData = useMemo(() => extractImageData(parsedResult), [parsedResult]);
  const imageData = inlineImageData || persistedImageData;
  const imageSrc = useMemo(
    () => (imageData ? `data:${imageData.mimeType};base64,${imageData.imageBase64}` : null),
    [imageData],
  );

  return { parsedResult, imageSrc, loading: loadingPersistedFile, persistedLoadError };
}
