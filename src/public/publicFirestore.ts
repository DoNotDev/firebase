// packages/providers/firebase/src/public/publicFirestore.ts

/**
 * @fileoverview Firestore public server instance
 * @description Firestore (Web SDK) instance for server reads as a signed-out visitor:
 * no auth instance, no service account, so Firestore Security Rules decide what it
 * reads (`request.auth == null`). Used by the routes the framework generates for
 * crawlers and prerendering (sitemap, llms.txt, entity pages).
 *
 * @version 0.1.0
 * @since 0.3.1
 * @author AMBROISE PARK Consulting
 */

import { getApps, initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import type { Firestore } from 'firebase/firestore';

import { connectFirestoreEmulatorFromEnv } from '../client/firestoreEmulator';

/**
 * Name of the Firebase app the public reader runs on, apart from the default app of
 * the client bootstrap (which may carry a signed-in user when rendered on the server).
 */
const PUBLIC_APP_NAME = 'dndev-public-reader';

/**
 * Public web config of the Firebase project (`NEXT_PUBLIC_FIREBASE_*`), never a
 * service-account key.
 *
 * @since 0.3.1
 */
export interface PublicFirestoreConfig {
  /** Web API key (`NEXT_PUBLIC_FIREBASE_API_KEY`) */
  apiKey: string;
  /** Project id (`NEXT_PUBLIC_FIREBASE_PROJECT_ID`) */
  projectId: string;
}

/**
 * Create the server-side Firestore instance of the public reader: its own Firebase app
 * with the project's public web config and no signed-in user, so every read is
 * checked by Security Rules as an unauthenticated request. Connects to the Firestore
 * emulator under the client's flags (`NODE_ENV=development` and
 * `NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true`), so `next dev` lists the emulator's
 * records like the client does; never at `next build`. Later calls in the same process
 * return the first instance.
 *
 * @param config - Public web config (API key, project id)
 * @returns Firestore instance for anonymous reads
 *
 * @example
 * ```ts
 * const crud = new FirestorePublicReader(createPublicServerFirestore({ apiKey, projectId }));
 * ```
 *
 * @version 0.1.0
 * @since 0.3.1
 */
export function createPublicServerFirestore(
  config: PublicFirestoreConfig
): Firestore {
  const existing = getApps().find((app) => app.name === PUBLIC_APP_NAME);
  if (existing) return getFirestore(existing);
  const firestore = getFirestore(
    initializeApp(
      { apiKey: config.apiKey, projectId: config.projectId },
      PUBLIC_APP_NAME
    )
  );
  connectFirestoreEmulatorFromEnv(firestore);
  return firestore;
}
