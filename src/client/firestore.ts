// packages/providers/firebase/src/client/firestore.ts

/**
 * @fileoverview Firestore Client SDK Exports
 * @description Re-exports all Firestore client functions with framework integration. Provides direct access to Firestore client SDK functions while maintaining the framework's separation between client-safe and server-only operations. All functions are browser-safe and can be used in client-side applications. Features direct Firestore SDK access, framework data transformation utilities integration, type-safe operations with proper error handling, real-time subscriptions support, and query building and filtering capabilities.
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import {
  getFirestore,
  connectFirestoreEmulator,
  type Firestore,
} from 'firebase/firestore';

import { getPlatformEnvVar, getGlobalSingleton } from '@donotdev/core';

import { getFirebaseSDK } from './sdk';

// =============================================================================
// Firestore Instance with Emulator Support (globalThis-backed)
// =============================================================================

interface FirestoreState {
  instance: Firestore | null;
  // NC5 fix: init promise guards against TOCTOU race - double connectFirestoreEmulator crashes SDK
  initPromise: Promise<Firestore> | null;
}

function getFirestoreState(): FirestoreState {
  return getGlobalSingleton<FirestoreState>('firebase-firestore', () => ({
    instance: null,
    initPromise: null,
  }));
}

/**
 * Get Firestore instance with automatic emulator connection
 *
 * Ensures Firebase app is initialized and returns Firestore instance.
 * Handles emulator connection automatically in development.
 * Safe to call from any consumer - handles initialization order automatically.
 *
 * @returns Promise resolving to Firestore instance
 * @throws Error if initialization fails
 *
 * @example
 * ```typescript
 * const firestore = await getFirebaseFirestore();
 * const docRef = doc(firestore, 'users', 'user123');
 * ```
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function getFirebaseFirestore(): Promise<Firestore> {
  const state = getFirestoreState();
  if (state.instance) return Promise.resolve(state.instance);
  // NC5: Return the in-flight promise so concurrent callers share one initialization
  if (state.initPromise) return state.initPromise;

  state.initPromise = (async () => {
    const sdk = getFirebaseSDK();
    const app = await sdk.getApp();
    const fs = getFirestore(app);

    // Connect to emulator in development
    const isDev = getPlatformEnvVar('NODE_ENV') === 'development';
    const useEmulator = getPlatformEnvVar('USE_FIREBASE_EMULATOR') === 'true';

    if (isDev && useEmulator) {
      const host = getPlatformEnvVar('FIREBASE_EMULATOR_HOST') || 'localhost';
      const port = parseInt(
        getPlatformEnvVar('FIREBASE_FIRESTORE_EMULATOR_PORT') || '8080'
      );
      connectFirestoreEmulator(fs, host, port);
    }

    state.instance = fs;
    state.initPromise = null;
    return state.instance;
  })();

  return state.initPromise;
}

// =============================================================================
// Core Firestore Functions
// =============================================================================

// Re-export getFirestore for direct usage (non-emulator aware)
export { getFirestore } from 'firebase/firestore';

/**
 * Document reference operations
 */
export {
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
} from 'firebase/firestore';

/**
 * Collection operations
 */
export { collection, collectionGroup } from 'firebase/firestore';

/**
 * Query operations
 */
export {
  query,
  where,
  orderBy,
  limit,
  limitToLast,
  startAt,
  startAfter,
  endAt,
  endBefore,
} from 'firebase/firestore';

/**
 * Real-time subscriptions
 */
export { onSnapshot, onSnapshotsInSync } from 'firebase/firestore';

/**
 * Batch operations
 */
export { writeBatch, runTransaction } from 'firebase/firestore';

/**
 * Server timestamp
 */
export {
  serverTimestamp,
  increment,
  arrayUnion,
  arrayRemove,
} from 'firebase/firestore';

/**
 * Field value operations
 * Note: Timestamp type is defined in @donotdev/core, this exports the Firebase SDK Timestamp class
 */
export { FieldValue, GeoPoint } from 'firebase/firestore';
export { Timestamp as FirestoreTimestampClass } from 'firebase/firestore';

// =============================================================================
// Framework Integration Utilities
// =============================================================================

/**
 * Transform Firestore data to application format
 * Converts Firestore Timestamps to ISO strings and handles other type conversions
 *
 * @param data - Raw Firestore document data
 * @returns Transformed data ready for application use
 *
 * @example
 * ```typescript
 * const snapshot = await getDoc(docRef);
 * const appData = transformFirestoreData(snapshot.data());
 * ```
 */
export { transformFirestoreData } from '../shared/transform';

/**
 * Convert ISO date strings to Date objects for schema validation
 * Schema validation expects Date objects for timestamp fields, not ISO strings.
 * This function recursively converts ISO date strings back to Date objects.
 *
 * @param data - Data containing ISO date strings
 * @returns Data with ISO strings converted to Date objects
 *
 * @example
 * ```typescript
 * const data = { createdAt: '2025-12-27T23:13:00.727Z' };
 * const converted = convertISOStringsToDates(data);
 * // { createdAt: Date('2025-12-27T23:13:00.727Z') }
 * ```
 */
export { convertISOStringsToDates } from '../shared/transform';

/**
 * Prepare application data for Firestore storage
 * Converts ISO strings to Firestore Timestamps and handles other type conversions
 *
 * @param data - Application data to store
 * @returns Data formatted for Firestore storage
 *
 * @example
 * ```typescript
 * const firestoreData = prepareForFirestore(userData);
 * await setDoc(docRef, firestoreData);
 * ```
 */
export { prepareForFirestore } from '../shared/transform';

/**
 * Convert Date or ISO string to Firestore Timestamp
 *
 * @param date - Date object or ISO string
 * @returns Firestore Timestamp
 *
 * @example
 * ```typescript
 * const timestamp = toTimestamp(new Date());
 * ```
 */
export { toTimestamp } from '../shared/transform';

/**
 * Convert DateValue to ISO string
 * Note: For generic Date conversion, use toISOString from @donotdev/core
 *
 * @param dateValue - Date, Timestamp, or ISO string
 * @returns ISO string representation
 *
 * @example
 * ```typescript
 * const isoString = firestoreToISOString(timestamp);
 * ```
 */
export { firestoreToISOString } from '../shared/transform';

/**
 * Create partial update object for Firestore
 *
 * @param updates - Partial data updates
 * @returns Firestore-compatible update object
 *
 * @example
 * ```typescript
 * const updates = createFirestorePartialUpdate({ name: 'New Name' });
 * await updateDoc(docRef, updates);
 * ```
 */
export { createFirestorePartialUpdate } from '../shared/transform';

// =============================================================================
// Type Exports
// =============================================================================

/**
 * Firestore types for TypeScript integration
 */
export type {
  DocumentData,
  DocumentSnapshot,
  QuerySnapshot,
  QueryDocumentSnapshot,
  DocumentReference,
  CollectionReference,
  Query,
  QueryConstraint,
  WhereFilterOp,
  OrderByDirection,
  FirestoreError,
  Unsubscribe,
  SnapshotOptions,
  DocumentChange,
  DocumentChangeType,
  Timestamp as FirestoreTimestamp,
  GeoPoint as FirestoreGeoPoint,
  FieldValue as FirestoreFieldValue,
} from 'firebase/firestore';
