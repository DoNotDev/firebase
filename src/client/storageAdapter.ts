// packages/providers/firebase/src/client/storageAdapter.ts

/**
 * @fileoverview Firebase Storage Adapter
 * @description IStorageAdapter implementation using Firebase Storage.
 * Wraps the existing Firebase storage utilities behind the provider-agnostic interface.
 *
 * @version 0.1.0
 * @since 0.5.0
 * @author AMBROISE PARK Consulting
 */

import type {
  IStorageAdapter,
  UploadOptions,
  UploadResult,
} from '@donotdev/core';
import { wrapStorageError } from '@donotdev/core';

import {
  uploadFileResumable,
  deleteFileByUrl,
  deleteFileByPath,
  getFileUrl,
} from './storage';

// =============================================================================
// Firebase Storage Adapter
// =============================================================================

/**
 * Firebase Storage adapter implementing IStorageAdapter.
 *
 * @example
 * ```typescript
 * import { FirebaseStorageAdapter } from '@donotdev/firebase';
 * import { configureProviders } from '@donotdev/core';
 *
 * configureProviders({
 *   crud: new FirestoreAdapter(),
 *   storage: new FirebaseStorageAdapter(),
 * });
 * ```
 *
 * @version 0.1.0
 * @since 0.5.0
 */
export class FirebaseStorageAdapter implements IStorageAdapter {
  async upload(
    file: File | Blob,
    options?: UploadOptions
  ): Promise<UploadResult> {
    try {
      const basePath = options?.storagePath ?? 'uploads';
      const { promise } = uploadFileResumable(file, {
        basePath,
        filename: options?.filename,
        onProgress: options?.onProgress
          ? (progress) => options.onProgress!(progress.progress)
          : undefined,
      });

      const result = await promise;
      if (!result.url || !result.path) {
        throw wrapStorageError(
          new Error('Upload returned no URL or path'),
          'FirebaseStorageAdapter',
          'upload',
          basePath
        );
      }
      return {
        url: result.url,
        path: result.path,
      };
    } catch (error) {
      throw wrapStorageError(
        error,
        'FirebaseStorageAdapter',
        'upload',
        options?.storagePath || 'uploads'
      );
    }
  }

  async delete(urlOrPath: string): Promise<void> {
    try {
      // Detect if it's a URL or a path
      if (urlOrPath.startsWith('http')) {
        await deleteFileByUrl(urlOrPath);
      } else {
        await deleteFileByPath(urlOrPath);
      }
    } catch (error) {
      throw wrapStorageError(
        error,
        'FirebaseStorageAdapter',
        'delete',
        urlOrPath
      );
    }
  }

  async getUrl(path: string): Promise<string> {
    try {
      return await getFileUrl(path);
    } catch (error) {
      throw wrapStorageError(error, 'FirebaseStorageAdapter', 'getUrl', path);
    }
  }
}
