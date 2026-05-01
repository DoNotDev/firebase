// packages/providers/firebase/src/client/callableProvider.ts

/**
 * @fileoverview Firebase Callable Provider
 * @description ICallableProvider implementation using Firebase Cloud Functions (httpsCallable).
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import type { ICallableProvider } from '@donotdev/core';
import { wrapCrudError, getPlatformEnvVar } from '@donotdev/core';

import { getFirebaseFunctions, httpsCallable } from './functions';

// =============================================================================
// FirebaseCallableProvider
// =============================================================================

/**
 * Invokes Firebase Cloud Functions via httpsCallable.
 * Implements ICallableProvider so FunctionsAdapter uses the same interface as Supabase/custom.
 *
 * @example
 * ```typescript
 * import { configureProviders } from '@donotdev/core';
 * import { FirebaseCallableProvider } from '@donotdev/firebase';
 *
 * configureProviders({
 *   callable: new FirebaseCallableProvider(),
 *   // ...other providers
 * });
 * ```
 */
export class FirebaseCallableProvider implements ICallableProvider {
  private readonly region: string;

  constructor(region?: string) {
    // Default: europe-west1 (European framework). Override via FIREBASE_FUNCTIONS_REGION env var.
    this.region =
      region ??
      getPlatformEnvVar('FIREBASE_FUNCTIONS_REGION') ??
      'europe-west1';
  }

  async call<TReq, TRes>(functionName: string, data: TReq): Promise<TRes> {
    try {
      const functions = await getFirebaseFunctions(this.region);
      const callableFn = httpsCallable<TReq, TRes>(functions, functionName);
      const result = await callableFn(data);
      return result.data as TRes;
    } catch (error) {
      throw wrapCrudError(
        error instanceof Error ? error : new Error(String(error)),
        'FirebaseCallableProvider',
        'call',
        functionName
      );
    }
  }
}
