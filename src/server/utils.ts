// packages/providers/firebase/src/server/utils.ts

/**
 * @fileoverview Server-only Firebase utilities
 * @description Server-only Firebase utilities. These functions should only be used in server-side code. Provides access to Firebase Admin SDK and Firestore server instances.
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { handleError } from '@donotdev/core/server';

import { getFirebaseAdminApp, getFirebaseAdminFirestore } from './init';

import type { App } from 'firebase-admin/app';
import type { Firestore } from 'firebase-admin/firestore';

// Server-only implementations
const serverImplementations = {
  async getServerAdmin(): Promise<App> {
    try {
      // NC1 fix: use initialized singleton from init.ts instead of re-importing firebase-admin
      return getFirebaseAdminApp();
    } catch (error) {
      throw handleError(error, 'Error getting Firebase Admin');
    }
  },

  async getServerFirestore(): Promise<Firestore> {
    try {
      // NC1 fix: delegate to the singleton managed by init.ts
      return getFirebaseAdminFirestore();
    } catch (error) {
      throw handleError(error, 'Error getting Admin Firestore');
    }
  },

  async generateServerId(): Promise<string> {
    const firestore = await serverImplementations.getServerFirestore();
    return firestore.collection('_').doc().id;
  },
};

/**
 * Get Firebase Admin App instance (server-only)
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const getServerAdmin: () => Promise<App> =
  serverImplementations.getServerAdmin;

/**
 * Get Firebase Admin Firestore instance (server-only)
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const getServerFirestore: () => Promise<Firestore> =
  serverImplementations.getServerFirestore;

/**
 * Generate Firestore document ID (server-only)
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const generateServerId = serverImplementations.generateServerId;
