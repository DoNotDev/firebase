// packages/providers/firebase/src/client/imageProcessing.ts

/**
 * @fileoverview Image processing utilities for client-side image optimization
 * @description Provides WebP conversion, resizing, and thumbnail generation
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import imageCompression from 'browser-image-compression';

/**
 * Standard image dimensions for processing
 */
export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Default dimensions for images
 */
export const DEFAULT_DIMENSIONS = {
  /** Full-size image dimensions (4:3 aspect ratio) */
  full: { width: 1600, height: 1200 },
  /** Thumbnail dimensions (4:3 aspect ratio) */
  thumbnail: { width: 320, height: 240 },
  /** Medium dimensions for cards/previews */
  medium: { width: 800, height: 600 },
} as const;

/**
 * Options for image processing
 */
export interface ImageProcessingOptions {
  /** Target dimensions */
  dimensions: ImageDimensions;
  /** WebP quality (0-1, default: 0.9) */
  quality?: number;
  /** Maximum file size in MB before compression (default: 2) */
  maxSizeMB?: number;
  /** Fill background color (default: transparent) */
  backgroundColor?: string;
  /** Whether to maintain aspect ratio (default: true) */
  maintainAspectRatio?: boolean;
}

/**
 * Result of image processing
 */
export interface ProcessedImage {
  /** Blob of the processed image */
  blob: Blob;
  /** MIME type (always image/webp) */
  mimeType: 'image/webp';
  /** Final dimensions */
  dimensions: ImageDimensions;
}

/**
 * Creates a standardized WebP image from a source file
 * @param file - Source file to process
 * @param options - Processing options
 * @returns Processed image as WebP blob
 */
export async function processImage(
  file: File,
  options: ImageProcessingOptions
): Promise<ProcessedImage> {
  const {
    dimensions,
    quality = 0.9,
    maxSizeMB = 2,
    backgroundColor,
    maintainAspectRatio = true,
  } = options;

  // NW3 fix: avoid new Promise(async ...) anti-pattern — unhandled promise rejections
  // inside the executor are swallowed by the Promise constructor. Instead await the
  // async work first, then wrap only the callback-based toBlob call in a Promise.
  const compressionOptions = { maxSizeMB, useWebWorker: true };
  const compressedFile = await imageCompression(file, compressionOptions);

  // Load image via a clean Promise wrapping only the event-based img.onload
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => {
      URL.revokeObjectURL(image.src);
      reject(new Error('Failed to load image'));
    };
    image.src = URL.createObjectURL(compressedFile);
  });

  URL.revokeObjectURL(img.src);

  // Create canvas with target dimensions
  const canvas = document.createElement('canvas');
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Could not get canvas context');
  }

  // Fill background
  if (backgroundColor) {
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  } else {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  let drawX = 0;
  let drawY = 0;
  let drawWidth = dimensions.width;
  let drawHeight = dimensions.height;

  if (maintainAspectRatio) {
    const scaleFactor = Math.min(
      dimensions.width / img.width,
      dimensions.height / img.height
    );
    drawWidth = img.width * scaleFactor;
    drawHeight = img.height * scaleFactor;
    drawX = (dimensions.width - drawWidth) / 2;
    drawY = (dimensions.height - drawHeight) / 2;
  }

  ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);

  // Wrap only the callback-based toBlob
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => {
        if (b) resolve(b);
        else reject(new Error('Failed to convert canvas to blob'));
      },
      'image/webp',
      quality
    );
  });

  return { blob, mimeType: 'image/webp', dimensions };
}

/**
 * Creates full-size and thumbnail versions of an image
 * @param file - Source file to process
 * @param options - Optional custom dimensions
 * @returns Object with full and thumbnail processed images
 */
export async function processImageWithThumbnail(
  file: File,
  options?: {
    fullDimensions?: ImageDimensions;
    thumbnailDimensions?: ImageDimensions;
    quality?: number;
    maxSizeMB?: number;
  }
): Promise<{
  full: ProcessedImage;
  thumbnail: ProcessedImage;
}> {
  const fullDimensions = options?.fullDimensions ?? DEFAULT_DIMENSIONS.full;
  const thumbnailDimensions =
    options?.thumbnailDimensions ?? DEFAULT_DIMENSIONS.thumbnail;

  const [full, thumbnail] = await Promise.all([
    processImage(file, {
      dimensions: fullDimensions,
      quality: options?.quality,
      maxSizeMB: options?.maxSizeMB,
    }),
    processImage(file, {
      dimensions: thumbnailDimensions,
      quality: options?.quality ?? 0.8, // Slightly lower quality for thumbnails
      maxSizeMB: 1, // Smaller max size for thumbnails
    }),
  ]);

  return { full, thumbnail };
}

/**
 * Validates an image file before processing
 * @param file - File to validate
 * @param options - Validation options
 * @returns Validation result
 */
export function validateImageFile(
  file: File,
  options?: {
    maxSizeMB?: number;
    allowedTypes?: string[];
  }
): { valid: boolean; error?: string } {
  const {
    maxSizeMB = 10,
    allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  } = options ?? {};

  // Check file type
  if (!allowedTypes.includes(file.type)) {
    return {
      valid: false,
      error: `Invalid file type. Allowed: ${allowedTypes.join(', ')}`,
    };
  }

  // Check file size
  const sizeMB = file.size / (1024 * 1024);
  if (sizeMB > maxSizeMB) {
    return {
      valid: false,
      error: `File too large (${sizeMB.toFixed(2)}MB). Maximum: ${maxSizeMB}MB`,
    };
  }

  return { valid: true };
}

/**
 * Creates a data URL preview of an image file
 * @param file - File to preview
 * @returns Data URL string
 */
export function createImagePreview(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Failed to read file'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}
