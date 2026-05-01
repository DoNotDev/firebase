// packages/providers/firebase/src/client/storage.ts

/**
 * @fileoverview Firebase Storage client SDK utilities
 * @description Browser-safe Storage operations for file uploads and downloads
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import {
  getStorage,
  ref,
  uploadBytes,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject,
  listAll,
  type StorageReference,
  type UploadTask,
  type UploadMetadata,
} from 'firebase/storage';

/**
 * Options for file upload (Firebase-specific, not to be confused with core UploadOptions)
 */
export interface FirebaseUploadOptions {
  /** Base path in storage (e.g., 'images', 'documents') */
  basePath: string;
  /** Optional subfolder (e.g., entity ID) */
  subfolder?: string;
  /** Custom filename (default: timestamp + original name) */
  filename?: string;
  /** Maximum file size in bytes (default: 10MB) */
  maxSize?: number;
}

/**
 * Result of a file upload (Firebase-specific, not to be confused with core UploadResult)
 */
export interface FirebaseUploadResult {
  /** Download URL of the uploaded file */
  url: string;
  /** Full storage path */
  path: string;
  /** Original filename */
  filename: string;
}

const DEFAULT_MAX_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * Sanitizes a filename for safe storage
 */
function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9.-]/g, '_');
}

/**
 * C3 fix: sanitize a path segment to prevent path traversal.
 * Strips leading/trailing slashes and any ".." components, then replaces
 * characters other than alphanumerics, hyphens, underscores, and dots.
 */
function sanitizePathSegment(segment: string): string {
  return segment
    .replace(/\.{2,}/g, '.') // Collapse consecutive dots to a single dot
    .replace(/^\/+|\/+$/g, '') // Strip leading/trailing slashes
    .replace(/[^a-zA-Z0-9._-]/g, '_'); // Allow safe chars only
}

/**
 * Generates a unique filename with timestamp
 */
function generateFilename(originalName: string, customName?: string): string {
  const timestamp = Date.now();
  const safeName = sanitizeFilename(customName || originalName);
  return `${timestamp}_${safeName}`;
}

/**
 * Builds the storage path from options
 * C3 fix: each dynamic segment is sanitized before joining to prevent path traversal.
 */
function buildPath(filename: string, options: FirebaseUploadOptions): string {
  const parts = [sanitizePathSegment(options.basePath)];
  if (options.subfolder) parts.push(sanitizePathSegment(options.subfolder));
  // filename is always produced by generateFilename which already sanitizes it
  parts.push(filename);
  return parts.join('/');
}

/**
 * Progress callback for resumable uploads
 */
export interface UploadProgressCallback {
  (progress: {
    bytesTransferred: number;
    totalBytes: number;
    progress: number; // 0-100
  }): void;
}

/**
 * Options for resumable file upload with progress tracking
 */
export interface UploadResumableOptions extends FirebaseUploadOptions {
  /** Progress callback */
  onProgress?: UploadProgressCallback;
  /** Upload metadata (content type, cache control, etc.) */
  metadata?: UploadMetadata;
}

/**
 * Uploads a single file to Firebase Storage with progress tracking
 * @param file - File or Blob to upload
 * @param options - Upload options with progress callback
 * @returns Upload task and promise resolving to upload result
 */
export function uploadFileResumable(
  file: File | Blob,
  options: UploadResumableOptions
): {
  task: UploadTask;
  promise: Promise<FirebaseUploadResult>;
} {
  const maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
  const fileName = file instanceof File ? file.name : 'blob';

  if (file.size > maxSize) {
    throw new Error(
      `File size (${(file.size / 1024 / 1024).toFixed(2)}MB) exceeds maximum allowed (${(maxSize / 1024 / 1024).toFixed(2)}MB)`
    );
  }

  const storage = getStorage();
  const filename = generateFilename(fileName, options.filename);
  const path = buildPath(filename, options);
  const storageRef = ref(storage, path);

  const metadata = options.metadata || {};
  const task = uploadBytesResumable(storageRef, file, metadata);

  if (options.onProgress) {
    task.on('state_changed', (snapshot) => {
      const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
      options.onProgress!({
        bytesTransferred: snapshot.bytesTransferred,
        totalBytes: snapshot.totalBytes,
        progress,
      });
    });
  }

  const promise = task.then(async () => {
    const url = await getDownloadURL(storageRef);
    return {
      url,
      path,
      filename: fileName,
    };
  }) as Promise<FirebaseUploadResult>;

  return { task, promise };
}

/**
 * Uploads a single file to Firebase Storage
 * @param file - File to upload
 * @param options - Upload options
 * @returns Upload result with URL and path
 * @throws Error if file exceeds max size
 */
export async function uploadFile(
  file: File,
  options: FirebaseUploadOptions
): Promise<FirebaseUploadResult> {
  const maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;

  if (file.size > maxSize) {
    throw new Error(
      `File size (${(file.size / 1024 / 1024).toFixed(2)}MB) exceeds maximum allowed (${(maxSize / 1024 / 1024).toFixed(2)}MB)`
    );
  }

  const storage = getStorage();
  const filename = generateFilename(file.name, options.filename);
  const path = buildPath(filename, options);
  const storageRef = ref(storage, path);

  await uploadBytes(storageRef, file);
  const url = await getDownloadURL(storageRef);

  return {
    url,
    path,
    filename: file.name,
  };
}

/**
 * Uploads multiple files to Firebase Storage
 * @param files - Array of files to upload
 * @param options - Upload options (same for all files)
 * @returns Array of upload results
 */
export async function uploadFiles(
  files: File[],
  options: FirebaseUploadOptions
): Promise<FirebaseUploadResult[]> {
  const uploadPromises = files.map((file) => uploadFile(file, options));
  return Promise.all(uploadPromises);
}

/**
 * Deletes a file from Firebase Storage by URL
 * @param url - Full download URL of the file
 */
export async function deleteFileByUrl(url: string): Promise<void> {
  try {
    const storage = getStorage();
    // NW10 fix: URL.pathname never contains '?' — query params live in URL.search.
    // Match everything after /o/ in the pathname only.
    const urlObj = new URL(url);
    const pathMatch = urlObj.pathname.match(/\/o\/(.+)$/);

    if (pathMatch && pathMatch[1]) {
      const decodedPath = decodeURIComponent(pathMatch[1]);
      const storageRef = ref(storage, decodedPath);
      await deleteObject(storageRef);
    }
  } catch (error) {
    console.warn('[Storage] Failed to delete file:', error);
    throw error;
  }
}

/**
 * Deletes a file from Firebase Storage by path
 * @param path - Storage path of the file
 */
export async function deleteFileByPath(path: string): Promise<void> {
  try {
    const storage = getStorage();
    const storageRef = ref(storage, path);
    await deleteObject(storageRef);
  } catch (error) {
    console.warn('[Storage] Failed to delete file:', error);
    throw error;
  }
}

/**
 * Deletes multiple files by their URLs
 * @param urls - Array of download URLs
 */
export async function deleteFilesByUrl(urls: string[]): Promise<void> {
  const deletePromises = urls.map((url) => deleteFileByUrl(url));
  await Promise.all(deletePromises);
}

/**
 * Lists all files in a storage path
 * @param path - Storage path to list
 * @returns Array of storage references
 */
export async function listFiles(path: string): Promise<StorageReference[]> {
  const storage = getStorage();
  const storageRef = ref(storage, path);
  const result = await listAll(storageRef);
  return result.items;
}

/**
 * Gets download URLs for all files in a path
 * @param path - Storage path to list
 * @returns Array of download URLs
 */
export async function getFileUrls(path: string): Promise<string[]> {
  const files = await listFiles(path);
  const urlPromises = files.map((fileRef) => getDownloadURL(fileRef));
  return Promise.all(urlPromises);
}

/**
 * Gets download URL for a file at a specific storage path
 * @param path - Storage path of the file
 * @returns Download URL
 */
export async function getFileUrl(path: string): Promise<string> {
  const storage = getStorage();
  const storageRef = ref(storage, path);
  return getDownloadURL(storageRef);
}

/**
 * Creates a storage reference for a given path
 * @param path - Storage path
 * @returns Storage reference
 */
export function createStorageRef(path: string): StorageReference {
  const storage = getStorage();
  return ref(storage, path);
}

/**
 * Deletes all files in a storage path
 * @param path - Storage path to clear
 */
export async function deleteAllFiles(path: string): Promise<void> {
  const files = await listFiles(path);
  const deletePromises = files.map((fileRef) => deleteObject(fileRef));
  await Promise.all(deletePromises);
}

// =============================================================================
// Convenience functions for common use cases
// =============================================================================

/**
 * Uploads an image file with common defaults
 * @param file - Image file to upload
 * @param entityType - Type of entity (e.g., 'cars', 'products')
 * @param entityId - Optional entity ID for organization
 * @returns Upload result
 */
export async function uploadImage(
  file: File,
  entityType: string,
  entityId?: string
): Promise<FirebaseUploadResult> {
  return uploadFile(file, {
    basePath: entityType,
    subfolder: entityId,
    maxSize: 5 * 1024 * 1024, // 5MB for images
  });
}

/**
 * Uploads multiple images
 * @param files - Image files to upload
 * @param entityType - Type of entity (e.g., 'cars', 'products')
 * @param entityId - Optional entity ID for organization
 * @returns Array of upload results
 */
export async function uploadImages(
  files: File[],
  entityType: string,
  entityId?: string
): Promise<FirebaseUploadResult[]> {
  return uploadFiles(files, {
    basePath: entityType,
    subfolder: entityId,
    maxSize: 5 * 1024 * 1024, // 5MB for images
  });
}

// =============================================================================
// Processed image uploads (with WebP conversion and thumbnails)
// =============================================================================

/**
 * Result of a processed image upload (full + thumbnail)
 */
export interface ProcessedUploadResult {
  /** Full-size image URL */
  fullUrl: string;
  /** Thumbnail image URL */
  thumbUrl: string;
  /** Full-size image path */
  fullPath: string;
  /** Thumbnail image path */
  thumbPath: string;
}

/**
 * Uploads an image with WebP conversion and thumbnail generation
 * Requires browser-image-compression package
 * @param file - Image file to upload
 * @param entityType - Type of entity (e.g., 'cars', 'products')
 * @param entityId - Optional entity ID for organization
 * @returns Object with full and thumbnail URLs
 */
export async function uploadProcessedImage(
  file: File,
  entityType: string,
  entityId?: string
): Promise<ProcessedUploadResult> {
  // Dynamic import to avoid bundling if not used
  const { processImageWithThumbnail } = await import('./imageProcessing');

  const { full, thumbnail } = await processImageWithThumbnail(file);

  const storage = getStorage();
  const timestamp = Date.now();
  const baseName = `${timestamp}_${file.name.replace(/\.[^/.]+$/, '')}`;
  // C3 fix: sanitize entityType and entityId before building paths
  const safeEntityType = sanitizePathSegment(entityType);
  const safeEntityId = entityId ? sanitizePathSegment(entityId) : undefined;

  const fullPath = safeEntityId
    ? `${safeEntityType}/${safeEntityId}/${baseName}_full.webp`
    : `${safeEntityType}/${baseName}_full.webp`;

  const thumbPath = safeEntityId
    ? `${safeEntityType}/${safeEntityId}/${baseName}_thumb.webp`
    : `${safeEntityType}/${baseName}_thumb.webp`;

  // Upload metadata with cache control
  const metadata = {
    contentType: 'image/webp',
    cacheControl: 'public, max-age=2592000', // 30 days
  };

  // Upload both versions in parallel
  const fullRef = ref(storage, fullPath);
  const thumbRef = ref(storage, thumbPath);

  await Promise.all([
    uploadBytes(fullRef, full.blob, metadata),
    uploadBytes(thumbRef, thumbnail.blob, metadata),
  ]);

  const [fullUrl, thumbUrl] = await Promise.all([
    getDownloadURL(fullRef),
    getDownloadURL(thumbRef),
  ]);

  return { fullUrl, thumbUrl, fullPath, thumbPath };
}

/**
 * Uploads multiple images with WebP conversion and thumbnails
 * @param files - Image files to upload
 * @param entityType - Type of entity
 * @param entityId - Optional entity ID
 * @returns Array of processed upload results
 */
export async function uploadProcessedImages(
  files: File[],
  entityType: string,
  entityId?: string
): Promise<ProcessedUploadResult[]> {
  const uploadPromises = files.map((file) =>
    uploadProcessedImage(file, entityType, entityId)
  );
  return Promise.all(uploadPromises);
}
