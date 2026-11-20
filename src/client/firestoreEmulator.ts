// packages/providers/firebase/src/client/firestoreEmulator.ts

/**
 * @fileoverview Firestore emulator connection
 * @description Connects a Firestore instance to the local emulator when the app's env
 * asks for it. Shared by the client Firestore instance and the public server reader
 * (`@donotdev/firebase/public`), so both read the same database in development.
 *
 * @version 0.1.0
 * @since 0.3.1
 * @author AMBROISE PARK Consulting
 */

import { connectFirestoreEmulator } from 'firebase/firestore';
import type { Firestore } from 'firebase/firestore';

import { getPlatformEnvVar } from '@donotdev/core';

/**
 * Connect `firestore` to the Firestore emulator when `NODE_ENV` is `development` and
 * `USE_FIREBASE_EMULATOR` is `true` (VITE_ / NEXT_PUBLIC_ prefixed), at
 * `FIREBASE_EMULATOR_HOST` (default `localhost`) and `FIREBASE_FIRESTORE_EMULATOR_PORT`
 * (default `8080`). Call once per instance, before its first read.
 *
 * @param firestore - Firestore instance not used yet
 *
 * @version 0.1.0
 * @since 0.3.1
 */
export function connectFirestoreEmulatorFromEnv(firestore: Firestore): void {
  const isDev = getPlatformEnvVar('NODE_ENV') === 'development';
  const useEmulator = getPlatformEnvVar('USE_FIREBASE_EMULATOR') === 'true';
  if (!isDev || !useEmulator) return;
  const host = getPlatformEnvVar('FIREBASE_EMULATOR_HOST') || 'localhost';
  const port = parseInt(
    getPlatformEnvVar('FIREBASE_FIRESTORE_EMULATOR_PORT') || '8080'
  );
  connectFirestoreEmulator(firestore, host, port);
}
