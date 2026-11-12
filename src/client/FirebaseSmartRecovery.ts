// packages/providers/firebase/src/client/FirebaseSmartRecovery.ts

/**
 * @fileoverview SmartRecovery - Firebase Error Recovery and Retry Strategies
 * @description Handles all Firebase error scenarios with appropriate recovery strategies. Called by FirebaseAuth when errors occur during authentication. Supports network issues with retry and backoff, rate limiting with exponential backoff, internal errors with retry and delay, account linking delegation, and user cancellation handling.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import type { FirebaseError } from 'firebase/app';

import { toast } from '@donotdev/components';
import {
  handleError,
  isDev,
  type AuthResult,
  type AuthPartnerId,
} from '@donotdev/core';
import { getAuthMethod, type AuthMethod } from '@donotdev/core';

import type { FirebaseUser, getFirebaseSDK } from './sdk';

/**
 * Firebase SDK error (structural: SDK errors and test doubles carry a string `code`).
 *
 * @internal
 */
export function isFirebaseError(error: unknown): error is FirebaseError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  );
}

/**
 * Code of a Firebase SDK error (`auth/...`), when the value carries one.
 *
 * @internal
 */
export function firebaseErrorCode(error: unknown): string | undefined {
  return isFirebaseError(error) ? error.code : undefined;
}

/**
 * String at `path` inside a value (e.g. a Firebase error's `customData._tokenResponse`,
 * which is SDK-internal and untyped).
 *
 * @internal
 */
export function nestedString(
  value: unknown,
  ...path: string[]
): string | undefined {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = Reflect.get(current, key);
  }
  return typeof current === 'string' ? current : undefined;
}

/** What a recovered operation resolves to (sign-in credential, or nothing for redirects). */
type RecoveryOperationResult = { user: FirebaseUser } | null | void;

/**
 * Context information for smart recovery
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export interface SmartRecoveryContext {
  email?: string;
  partnerId?: AuthPartnerId;
  method?: AuthMethod;
}

/**
 * Dependencies required for smart recovery
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export interface SmartRecoveryDependencies {
  sdk: ReturnType<typeof getFirebaseSDK>;
  handleAccountLinking: (
    error: FirebaseError,
    attemptedProvider: AuthPartnerId,
    method: AuthMethod
  ) => Promise<AuthResult | null>;
  createAuthResult: (user: FirebaseUser, isNewUser?: boolean) => AuthResult;
}

/**
 * Centralized smart recovery handler
 *
 * Handles all Firebase error scenarios with appropriate recovery strategies.
 * Wraps unrecoverable errors with handleError() before throwing.
 *
 * **Recovery Strategies:**
 * - Network issues: Linear backoff (1s, 2s, 3s)
 * - Rate limiting: Exponential backoff (2s, 4s, 8s)
 * - Internal errors: Simple retry with 2s delay
 * - Account linking: Delegate to account linking handler
 * - User cancellation: Return null (not an error)
 *
 * @param error - Firebase error object
 * @param operation - Operation to retry
 * @param context - Context information for recovery
 * @param deps - Dependencies for recovery operations
 * @returns Auth result or null if user cancelled
 * @throws DoNotDevError if recovery fails
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function handleSmartRecovery(
  error: unknown,
  operation: () => Promise<RecoveryOperationResult>,
  context: SmartRecoveryContext,
  deps: SmartRecoveryDependencies
): Promise<AuthResult | null> {
  const code = firebaseErrorCode(error);

  // Network issues → retry with backoff
  if (code === 'auth/network-request-failed') {
    toast('info', 'Connection issue - retrying...');
    try {
      return await retryWithBackoff(operation, deps);
    } catch (retryError) {
      throw handleError(retryError, {
        userMessage:
          'Network connection failed. Please check your internet and try again.',
        context: { operation: 'network-retry', originalError: code },
        showNotification: true,
      });
    }
  }

  // Rate limiting → exponential backoff
  if (code === 'auth/too-many-requests') {
    toast('info', 'Rate limited - retrying with backoff...');
    try {
      return await retryWithExponentialBackoff(operation, deps);
    } catch (retryError) {
      throw handleError(retryError, {
        userMessage: 'Too many attempts. Please wait a moment and try again.',
        context: { operation: 'rate-limit-retry', originalError: code },
        showNotification: true,
      });
    }
  }

  // Internal errors → retry with delay
  if (code === 'auth/internal-error') {
    toast('info', 'Temporary issue - retrying...');
    try {
      return await retryWithDelay(operation, deps);
    } catch (retryError) {
      throw handleError(retryError, {
        userMessage: 'A temporary error occurred. Please try again.',
        context: {
          operation: 'internal-error-retry',
          originalError: code,
        },
        showNotification: true,
      });
    }
  }

  // Account linking → handle linking
  if (
    code === 'auth/account-exists-with-different-credential' &&
    isFirebaseError(error)
  ) {
    try {
      return await deps.handleAccountLinking(
        error,
        context.partnerId!,
        context.method ? getAuthMethod(context.method) : getAuthMethod()
      );
    } catch (linkingError) {
      throw handleError(linkingError, {
        userMessage: 'Failed to link accounts. Please try again.',
        context: { operation: 'account-linking', originalError: code },
        showNotification: true,
      });
    }
  }

  // User cancellation → return null (not an error)
  if (
    code === 'auth/popup-closed-by-user' ||
    code === 'auth/cancelled-popup-request' ||
    code === 'auth/popup-blocked'
  ) {
    return null;
  }

  // Can't handle → wrap and throw
  throw handleError(error, {
    userMessage: getErrorMessage(code),
    context: { operation: 'smart-recovery', errorCode: code },
    showNotification: true,
  });
}

/**
 * User of a retried operation's credential. An operation without one (redirect,
 * no-op) fails the retry, as reading `.user` of nothing did before typing.
 */
function requireUser(result: RecoveryOperationResult): FirebaseUser {
  if (!result) {
    throw new TypeError('Recovered operation returned no credential');
  }
  return result.user;
}

/**
 * Retry operation with linear backoff
 *
 * Retries up to 3 times with increasing delays (1s, 2s, 3s).
 *
 * @param operation - Operation to retry
 * @param deps - Dependencies for creating auth result
 * @param maxRetries - Maximum number of retries (default: 3)
 * @returns Auth result or null
 * @throws Error if all retries fail
 * @private
 */
async function retryWithBackoff(
  operation: () => Promise<RecoveryOperationResult>,
  deps: SmartRecoveryDependencies,
  maxRetries = 3
): Promise<AuthResult | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return deps.createAuthResult(requireUser(await operation()));
    } catch (error: unknown) {
      if (
        attempt === maxRetries ||
        firebaseErrorCode(error) !== 'auth/network-request-failed'
      ) {
        throw error;
      }
      const delay = attempt * 1000; // 1s, 2s, 3s
      if (isDev()) {
        console.log(
          `[SmartRecovery] Retry attempt ${attempt}/${maxRetries} in ${delay}ms`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error('Max retries exceeded');
}

/**
 * Retry operation with exponential backoff
 *
 * Retries up to 3 times with exponentially increasing delays (2s, 4s, 8s).
 *
 * @param operation - Operation to retry
 * @param deps - Dependencies for creating auth result
 * @param maxRetries - Maximum number of retries (default: 3)
 * @returns Auth result or null
 * @throws Error if all retries fail
 * @private
 */
async function retryWithExponentialBackoff(
  operation: () => Promise<RecoveryOperationResult>,
  deps: SmartRecoveryDependencies,
  maxRetries = 3
): Promise<AuthResult | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return deps.createAuthResult(requireUser(await operation()));
    } catch (error: unknown) {
      if (
        attempt === maxRetries ||
        firebaseErrorCode(error) !== 'auth/too-many-requests'
      ) {
        throw error;
      }
      const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
      if (isDev()) {
        console.log(
          `[SmartRecovery] Exponential backoff attempt ${attempt}/${maxRetries} in ${delay}ms`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error('Max retries exceeded');
}

/**
 * Retry operation with simple delay
 *
 * Retries up to 2 times with 2s delay between attempts.
 *
 * @param operation - Operation to retry
 * @param deps - Dependencies for creating auth result
 * @param maxRetries - Maximum number of retries (default: 2)
 * @returns Auth result or null
 * @throws Error if all retries fail
 * @private
 */
async function retryWithDelay(
  operation: () => Promise<RecoveryOperationResult>,
  deps: SmartRecoveryDependencies,
  maxRetries = 2
): Promise<AuthResult | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return deps.createAuthResult(requireUser(await operation()));
    } catch (error: unknown) {
      if (
        attempt === maxRetries ||
        firebaseErrorCode(error) !== 'auth/internal-error'
      ) {
        throw error;
      }
      const delay = 2000; // 2s delay
      if (isDev()) {
        console.log(
          `[SmartRecovery] Internal error retry attempt ${attempt}/${maxRetries} in ${delay}ms`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error('Max retries exceeded');
}

/**
 * Get user-friendly error message for Firebase error codes
 *
 * Maps Firebase error codes to helpful user messages.
 *
 * @param errorCode - Firebase error code
 * @returns User-friendly error message
 * @private
 */
function getErrorMessage(errorCode: string | undefined): string {
  const errorMessages: Record<string, string> = {
    'auth/invalid-email': 'Invalid email address',
    'auth/user-disabled': 'This account has been disabled',
    'auth/user-not-found': 'Invalid email or password',
    'auth/wrong-password': 'Invalid email or password',
    'auth/email-already-in-use': 'An account already exists with this email',
    'auth/weak-password': 'Password is too weak',
    'auth/operation-not-allowed': 'This sign-in method is not enabled',
    'auth/invalid-credential': 'Invalid credentials provided',
    'auth/invalid-verification-code': 'Invalid verification code',
    'auth/invalid-verification-id': 'Invalid verification ID',
    'auth/expired-action-code': 'This link has expired',
    'auth/invalid-action-code': 'Invalid or expired link',
    'auth/credential-already-in-use':
      'This credential is already associated with another account',
    'auth/requires-recent-login': 'Please sign in again to continue',
    'auth/popup-blocked':
      'Popup was blocked by your browser. Please allow popups and try again.',
  };

  return (
    (errorCode && errorMessages[errorCode]) || 'An authentication error occurred'
  );
}
