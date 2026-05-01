// packages/providers/firebase/src/client/functions.ts

/**
 * @fileoverview Firebase Functions Client SDK
 * @description Framework-integrated Firebase Functions client utilities. Provides singleton access to Firebase Functions with automatic app initialization and emulator support.
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import {
  getFunctions,
  connectFunctionsEmulator,
  type Functions,
} from 'firebase/functions';

import { getPlatformEnvVar } from '@donotdev/core';

import { getFirebaseSDK } from './sdk';

/**
 * Track which Functions instances have been connected to emulator
 * Key: `${app.name}_${region}`
 */
const connectedFunctions = new Set<string>();

/**
 * Get Firebase Functions instance
 *
 * Ensures Firebase app is initialized and returns Functions instance.
 * Handles emulator connection automatically in development.
 * Safe to call from any consumer - handles initialization order automatically.
 *
 * @param region - Functions region (defaults to FIREBASE_FUNCTIONS_REGION or 'europe-west1')
 * @returns Promise resolving to Functions instance
 * @throws Error if initialization fails
 *
 * @example
 * ```typescript
 * const functions = await getFirebaseFunctions('europe-west1');
 * const callable = httpsCallable(functions, 'myFunction');
 * ```
 */
export async function getFirebaseFunctions(
  region?: string
): Promise<Functions> {
  const sdk = getFirebaseSDK();
  const app = await sdk.getApp();
  const functionsRegion =
    region || getPlatformEnvVar('FIREBASE_FUNCTIONS_REGION') || 'europe-west1';
  const functions = getFunctions(app, functionsRegion);

  // Connect to emulator in development
  // Can only connect once per Functions instance - guard against multiple calls
  const isDev = getPlatformEnvVar('NODE_ENV') === 'development';
  const useEmulator = getPlatformEnvVar('USE_FIREBASE_EMULATOR') === 'true';

  if (isDev && useEmulator) {
    const connectionKey = `${app.name}_${functionsRegion}`;
    if (!connectedFunctions.has(connectionKey)) {
      const emulatorHost =
        getPlatformEnvVar('FIREBASE_EMULATOR_HOST') || 'localhost';
      const emulatorPort =
        getPlatformEnvVar('FIREBASE_FUNCTIONS_EMULATOR_PORT') || '5001';
      try {
        connectFunctionsEmulator(
          functions,
          emulatorHost,
          parseInt(emulatorPort)
        );
        connectedFunctions.add(connectionKey);
        if (
          typeof window !== 'undefined' &&
          getPlatformEnvVar('NODE_ENV') === 'development'
        ) {
          console.log('[FirebaseFunctions] Connected to emulator:', {
            host: emulatorHost,
            port: emulatorPort,
            region: functionsRegion,
          });
        }
      } catch (error) {
        // If already connected, that's fine
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        if (!errorMessage.includes('already')) {
          console.warn(
            '[FirebaseFunctions] Failed to connect to emulator:',
            error
          );
        } else {
          // Already connected - that's fine
          if (
            typeof window !== 'undefined' &&
            getPlatformEnvVar('NODE_ENV') === 'development'
          ) {
            console.log('[FirebaseFunctions] Already connected to emulator');
          }
        }
        connectedFunctions.add(connectionKey);
      }
    }
  }

  return functions;
}

// Re-export Firebase Functions types and utilities
export {
  httpsCallable,
  type HttpsCallable,
  type HttpsCallableOptions,
  type HttpsCallableResult,
} from 'firebase/functions';
