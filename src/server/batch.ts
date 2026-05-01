// packages/providers/firebase/src/server/batch.ts

/**
 * @fileoverview Firebase batch operations
 * @description Core utilities for batch operations with Firebase and Firestore. Provides batch write, transaction, and atomic operation support for server-side Firestore operations.
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import type { dndevSchema } from '@donotdev/core';
import { handleError } from '@donotdev/core/server';

import { getServerFirestore } from './utils';
import {
  prepareForFirestore,
  transformFirestoreData,
} from '../shared/transform';

import type {
  DocumentReference,
  DocumentSnapshot,
} from 'firebase-admin/firestore';

// Structural type matching firebase-admin Transaction without importing it directly
// (avoids module resolution issues in some bundler configurations)
interface FirestoreTransaction {
  get: (docRef: DocumentReference) => Promise<DocumentSnapshot>;
  set: (
    docRef: DocumentReference,
    data: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => FirestoreTransaction;
  update: (
    docRef: DocumentReference,
    data: Record<string, unknown>
  ) => FirestoreTransaction;
  delete: (docRef: DocumentReference) => FirestoreTransaction;
}

/**
 * Result of a batch operation
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export interface BatchResult {
  /** Number of successful operations */
  successes: number;
  /** Number of failed operations */
  failures: number;
  /** Failed items with error information */
  failedItems?: Array<{
    index: number;
    error: Error;
  }>;
}

/**
 * Options for batch operations
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export interface BatchOptions {
  /** Field to use as document ID */
  idField?: string;
  /** Generate IDs for documents without them */
  generateIds?: boolean;
  /** Maximum batch size (Firestore has a limit of 500) */
  maxBatchSize?: number;
  /** Fields to remove before saving to Firestore */
  removeFields?: string[];
  /** Whether to validate items using the schema */
  validate?: boolean;
}

// Determine if we're in a browser
const isClient = typeof window !== 'undefined';

// Server-only implementations
const serverImplementations = {
  /**
   * Performs a batch write operation on multiple documents
   */
  async batchWrite<T extends Record<string, any>>(
    collection: string,
    items: T[],
    operation: 'create' | 'update' | 'delete',
    schema?: dndevSchema<T>,
    options: BatchOptions = {}
  ): Promise<BatchResult> {
    if (!items || !items.length) {
      return { successes: 0, failures: 0 };
    }

    const {
      idField = 'id',
      generateIds = true,
      maxBatchSize = 450,
      removeFields = [],
      validate = !!schema,
    } = options;

    const result: BatchResult = {
      successes: 0,
      failures: 0,
      failedItems: [],
    };

    try {
      // Process items in batches to respect Firestore limits
      const batches = [];
      const firestore = await getServerFirestore();
      let currentBatch = firestore.batch();
      let currentBatchSize = 0;

      // Process each item
      for (let i = 0; i < items.length; i++) {
        let item = items[i];

        if (!item) {
          result.failures++;
          result.failedItems?.push({
            index: i,
            error: new Error('Item is null or undefined'),
          });
          continue;
        }

        try {
          // For delete operations, we only need the ID
          if (operation === 'delete') {
            if (!item[idField]) {
              throw handleError(
                new Error(`Missing ID for delete operation (${idField})`),
                {
                  userMessage: 'Unable to delete item: missing ID',
                  severity: 'error',
                  context: { collection, idField, operation },
                }
              );
            }

            const docRef = firestore.collection(collection).doc(item[idField]);

            currentBatch.delete(docRef);
          } else {
            // For create/update, perform validation if needed
            if (validate && schema) {
              try {
                v.parse(schema, item);
              } catch (error) {
                throw handleError(error, {
                  userMessage: 'Validation failed for item',
                  severity: 'warning',
                  context: {
                    collection,
                    operation,
                    idField,
                    itemId: item[idField],
                  },
                });
              }
            }

            // Get or generate document ID
            let docId = item[idField];

            if (!docId && operation === 'create' && generateIds) {
              // Generate ID for create operations
              docId = firestore.collection(collection).doc().id;
              item = { ...item, [idField]: docId } as T;
            } else if (!docId) {
              throw handleError(
                new Error(`Missing ID for ${operation} operation (${idField})`),
                {
                  userMessage: `Unable to ${operation} item: missing ID`,
                  severity: 'error',
                  context: { collection, idField, operation },
                }
              );
            }

            // Prepare data for Firestore (remove ID field and convert dates)
            const fieldsToRemove = [idField, ...removeFields];
            const preparedData = prepareForFirestore(item, fieldsToRemove);

            // Get document reference
            const docRef = firestore.collection(collection).doc(docId);

            // Add to batch based on operation
            if (operation === 'create') {
              currentBatch.create(docRef, preparedData);
            } else if (operation === 'update') {
              currentBatch.update(docRef, preparedData);
            }
          }

          // Increment batch size (successes counted after commit)
          currentBatchSize++;

          // If we've reached max batch size, commit and start a new batch
          if (currentBatchSize >= maxBatchSize) {
            batches.push({ batch: currentBatch, size: currentBatchSize });
            currentBatch = firestore.batch();
            currentBatchSize = 0;
          }
        } catch (error) {
          result.failures++;
          result.failedItems?.push({
            index: i,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }

      // Add the final batch if it contains any operations
      if (currentBatchSize > 0) {
        batches.push({ batch: currentBatch, size: currentBatchSize });
      }

      // Execute all batches — count successes only after commit succeeds
      let batchOffset = 0;
      for (const { batch, size } of batches) {
        try {
          await batch.commit();
          result.successes += size;
        } catch (error) {
          // NW12 fix: populate failedItems so callers can identify which items failed.
          // Previously only `failures` was incremented, leaving failedItems empty and
          // making batch-level failures unrecoverable/unidentifiable.
          const batchError =
            error instanceof Error ? error : new Error(String(error));
          for (let i = batchOffset; i < batchOffset + size; i++) {
            result.failures++;
            result.failedItems?.push({ index: i, error: batchError });
          }
        }
        batchOffset += size;
      }

      return result;
    } catch (error) {
      // Handle overall batch error
      throw handleError(error, {
        userMessage: `Batch ${operation} operation failed for collection ${collection}`,
        context: {
          collection,
          operation,
          itemCount: items.length,
          processedCount: result.successes + result.failures,
          successCount: result.successes,
          failureCount: result.failures,
        },
      });
    }
  },

  /**
   * Performs a batch create operation
   */
  async batchCreate<T extends Record<string, any>>(
    collection: string,
    items: T[],
    schema?: dndevSchema<T>,
    options: BatchOptions = {}
  ): Promise<BatchResult> {
    return serverImplementations.batchWrite(
      collection,
      items,
      'create',
      schema,
      options
    );
  },

  /**
   * Performs a batch update operation
   */
  async batchUpdate<T extends Record<string, any>>(
    collection: string,
    items: T[],
    schema?: dndevSchema<T>,
    options: BatchOptions = {}
  ): Promise<BatchResult> {
    return serverImplementations.batchWrite(
      collection,
      items,
      'update',
      schema,
      options
    );
  },

  /**
   * Performs a batch delete operation
   */
  async batchDelete<T extends Record<string, any>>(
    collection: string,
    items: T[] | string[],
    options: BatchOptions = {}
  ): Promise<BatchResult> {
    // If we have string IDs, convert to objects with ID field
    if (items.length > 0 && typeof items[0] === 'string') {
      const idField = options.idField || 'id';
      const objectItems = (items as string[]).map((id) => {
        return { [idField]: id } as unknown as T;
      });
      return serverImplementations.batchWrite(
        collection,
        objectItems,
        'delete',
        undefined,
        options
      );
    }

    return serverImplementations.batchWrite(
      collection,
      items as T[],
      'delete',
      undefined,
      options
    );
  },

  /**
   * Runs a transaction with proper error handling
   */
  async runTransaction<T>(
    updateFunction: (transaction: FirestoreTransaction) => Promise<T>
  ): Promise<T> {
    try {
      const firestore = await getServerFirestore();
      return await firestore.runTransaction(updateFunction);
    } catch (error) {
      throw handleError(error, {
        userMessage: 'Transaction failed',
      });
    }
  },

  /**
   * Fetches multiple documents by ID in a single batch
   */
  async bulkGet<T = Record<string, any>>(
    collection: string,
    ids: string[],
    options: {
      maxBatchSize?: number;
      transform?: boolean;
    } = {}
  ): Promise<Array<T | null>> {
    if (!ids.length) return [];

    const { maxBatchSize = 30, transform = true } = options;

    try {
      // Split IDs into batches
      const batches = [];
      for (let i = 0; i < ids.length; i += maxBatchSize) {
        batches.push(ids.slice(i, i + maxBatchSize));
      }

      // Process each batch
      const batchPromises = batches.map(async (batchIds) => {
        const firestore = await getServerFirestore();
        const collectionRef = firestore.collection(collection);
        const docs = await collectionRef
          .where('__name__', 'in', batchIds)
          .get();

        // Create a map of id -> document
        const docMap = new Map<string, any>();
        docs.forEach((doc: { id: string; data: () => any }) => {
          docMap.set(doc.id, doc.data());
        });

        // Return documents in the same order as requested
        return batchIds.map((id) => {
          const data = docMap.get(id);
          if (!data) return null;

          // Transform if requested
          const result = transform
            ? transformFirestoreData({ id, ...data })
            : { id, ...data };

          return result as T;
        });
      });

      // Execute all batch requests
      const results = await Promise.all(batchPromises);

      // Flatten results
      return results.flat();
    } catch (error) {
      throw handleError(error, {
        userMessage: `Bulk get operation failed for collection ${collection}`,
        context: {
          collection,
          idCount: ids.length,
        },
      });
    }
  },
};

// Create browser-safe stubs for server-only functions
const notAvailableInBrowser = (fnName: string) => () => {
  throw new Error(
    `Firebase Admin function '${fnName}' is not available in browser environments`
  );
};

/**
 * Batch write operation (server-only)
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const batchWrite = isClient
  ? notAvailableInBrowser('batchWrite')
  : serverImplementations.batchWrite;

/**
 * Batch create operation (server-only)
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const batchCreate = isClient
  ? notAvailableInBrowser('batchCreate')
  : serverImplementations.batchCreate;

/**
 * Batch update operation (server-only)
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const batchUpdate = isClient
  ? notAvailableInBrowser('batchUpdate')
  : serverImplementations.batchUpdate;

/**
 * Batch delete operation (server-only)
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const batchDelete = isClient
  ? notAvailableInBrowser('batchDelete')
  : serverImplementations.batchDelete;

/**
 * Run transaction operation (server-only)
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const runTransaction = isClient
  ? notAvailableInBrowser('runTransaction')
  : serverImplementations.runTransaction;

/**
 * Bulk get operation (server-only)
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const bulkGet = isClient
  ? notAvailableInBrowser('bulkGet')
  : serverImplementations.bulkGet;
