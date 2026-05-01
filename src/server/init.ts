// packages/providers/firebase/src/server/init.ts

/**
 * @fileoverview Server-side Firebase Admin initialization
 * @description Initializes Firebase Admin SDK for Firebase Functions and server-side code. Manages Firebase Admin app, auth, Firestore, and functions instances with caching.
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getFunctions } from 'firebase-admin/functions';

import { handleError, createSingleton } from '@donotdev/core/server';

import type { App } from 'firebase-admin/app';
import type { Auth } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import type { Functions } from 'firebase-admin/functions';

/** Cached Firebase Admin SDK service instances (app, auth, firestore, functions). */
export interface FirebaseAdminServices {
  app: App | null;
  // W1 fix: use proper Admin SDK types instead of any
  auth: Auth | null;
  firestore: Firestore | null;
  functions: Functions | null;
}

function initializeFirebaseAdminServices(): FirebaseAdminServices {
  // FIREBASE_AUTH_EMULATOR_HOST and FIREBASE_FIRESTORE_EMULATOR_HOST are set by createEmulatorEnv
  // based on user's service selections in the emu command
  // If they're set, Admin SDK will use emulators
  // If they're not set (or deleted), Admin SDK will use production services
  // Don't modify them here - respect the user's explicit choices

  const existingApps = getApps();
  let app: App | null = null;

  if (existingApps.length === 0) {
    // Check if we're in Vercel environment (has service account env vars)
    const isVercelEnv =
      process.env.FIREBASE_ADMIN_PRIVATE_KEY &&
      process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_CLIENT_EMAIL;

    if (isVercelEnv) {
      // Vercel environment - use service account credentials
      app = initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_PROJECT_ID!,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL!,
          privateKey: process.env.FIREBASE_ADMIN_PRIVATE_KEY!.replace(
            /\\n/g,
            '\n'
          ),
        }),
        projectId: process.env.FIREBASE_PROJECT_ID!,
      });
    } else {
      // Firebase Functions environment - use default credentials (auto-discovery)
      app = initializeApp();
    }
  } else {
    app = existingApps[0] || null;
  }

  if (!app) {
    throw new Error('Failed to initialize Firebase Admin app');
  }

  return {
    app,
    auth: getAuth(app),
    firestore: getFirestore(app),
    functions: getFunctions(app),
  };
}

const getFirebaseAdminServices = createSingleton(
  initializeFirebaseAdminServices
);

/** Initialize Firebase Admin SDK and return all service instances. */
export async function initFirebaseAdmin(): Promise<FirebaseAdminServices> {
  try {
    return getFirebaseAdminServices();
  } catch (error) {
    throw handleError(error, {
      userMessage: 'Failed to initialize Firebase Admin',
      context: { provider: 'FirebaseAdmin', operation: 'initFirebaseAdmin' },
      severity: 'error',
    });
  }
}

/** Get the initialized Firebase Admin App instance. */
export async function getFirebaseAdminApp(): Promise<App> {
  const services = getFirebaseAdminServices();
  if (!services.app) {
    throw new Error('Firebase Admin not initialized');
  }
  return services.app;
}

/** Get the Firebase Admin Auth instance for server-side auth operations. */
export function getFirebaseAdminAuth(): Auth {
  const services = getFirebaseAdminServices();
  if (!services.auth) {
    throw new Error('Firebase Admin auth not initialized');
  }
  return services.auth;
}

/** Get the Firebase Admin Firestore instance for server-side database operations. */
export function getFirebaseAdminFirestore(): Firestore {
  const services = getFirebaseAdminServices();
  if (!services.firestore) {
    throw new Error('Firebase Admin firestore not initialized');
  }
  return services.firestore;
}

/** Get the Firebase Admin Functions instance for server-side function management. */
export function getFirebaseAdminFunctions(): Functions {
  const services = getFirebaseAdminServices();
  if (!services.functions) {
    throw new Error('Firebase Admin functions not initialized');
  }
  return services.functions;
}
