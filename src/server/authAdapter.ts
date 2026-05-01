// packages/providers/firebase/src/server/authAdapter.ts

/**
 * @fileoverview Firebase Server Auth Adapter
 * @description IServerAuthAdapter implementation using Firebase Admin SDK.
 * Wraps Firebase Admin auth operations behind the provider-agnostic interface.
 *
 * @version 0.1.0
 * @since 0.5.0
 * @author AMBROISE PARK Consulting
 */

import type {
  IServerAuthAdapter,
  VerifiedToken,
  ServerUserRecord,
} from '@donotdev/core';
import { wrapAuthError } from '@donotdev/core';

import { getFirebaseAdminAuth } from './init';

// =============================================================================
// Firebase Server Auth Adapter
// =============================================================================

/**
 * Firebase Admin SDK adapter implementing IServerAuthAdapter.
 *
 * @example
 * ```typescript
 * import { FirebaseServerAuthAdapter } from '@donotdev/firebase/server';
 * import { configureProviders } from '@donotdev/core';
 *
 * configureProviders({
 *   crud: new FirestoreAdapter(),
 *   serverAuth: new FirebaseServerAuthAdapter(),
 * });
 * ```
 *
 * @version 0.1.0
 * @since 0.5.0
 */
export class FirebaseServerAuthAdapter implements IServerAuthAdapter {
  async verifyToken(token: string): Promise<VerifiedToken> {
    try {
      // Lazy initialization — never call getFirebaseAdminAuth() at module load
      const decodedToken = await getFirebaseAdminAuth().verifyIdToken(token);
      return {
        uid: decodedToken.uid,
        email: decodedToken.email,
        claims: decodedToken as unknown as Record<string, unknown>,
      };
    } catch (error) {
      throw wrapAuthError(error, 'FirebaseServerAuthAdapter', 'verifyToken');
    }
  }

  async getUser(uid: string): Promise<ServerUserRecord | null> {
    try {
      const user = await getFirebaseAdminAuth().getUser(uid);
      return {
        uid: user.uid,
        email: user.email,
        displayName: user.displayName,
        customClaims: (user.customClaims as Record<string, unknown>) ?? {},
      };
    } catch (error: unknown) {
      // NW7 fix: only swallow "user not found" errors — re-throw infrastructure failures.
      // Silently returning null for all errors hides outages and auth misconfigurations.
      const code = (error as { code?: string }).code;
      if (code === 'auth/user-not-found') {
        return null;
      }
      throw wrapAuthError(error, 'FirebaseServerAuthAdapter', 'getUser', {
        uid,
      });
    }
  }

  async setCustomClaims(
    uid: string,
    claims: Record<string, unknown>
  ): Promise<void> {
    try {
      // Merge with existing claims
      const user = await getFirebaseAdminAuth().getUser(uid);
      const existingClaims =
        (user.customClaims as Record<string, unknown>) ?? {};
      await getFirebaseAdminAuth().setCustomUserClaims(uid, {
        ...existingClaims,
        ...claims,
      });
    } catch (error) {
      throw wrapAuthError(
        error,
        'FirebaseServerAuthAdapter',
        'setCustomClaims',
        { uid }
      );
    }
  }
}
