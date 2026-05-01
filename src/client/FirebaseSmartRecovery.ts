// packages/providers/firebase/src/client/FirebaseSmartRecovery.ts

/**
 * @fileoverview SmartRecovery - Firebase Error Recovery and Retry Strategies
 * @description Handles all Firebase error scenarios with appropriate recovery strategies. Called by FirebaseAuth when errors occur during authentication. Supports network issues with retry and backoff, rate limiting with exponential backoff, internal errors with retry and delay, account linking delegation, and user cancellation handling.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { toast } from '@donotdev/components';
import {
  handleError,
  isDev,
  type AuthResult,
  type AuthPartnerId,
} from '@donotdev/core';
import { getAuthMethod, type AuthMethod } from '@donotdev/core';

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
  sdk: any;
  handleAccountLinking: (
    error: any,
    attemptedProvider: AuthPartnerId,
    method: AuthMethod
  ) => Promise<AuthResult | null>;
  createAuthResult: (user: any, isNewUser?: boolean) => AuthResult;
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
  error: any,
  operation: () => Promise<any>,
  context: SmartRecoveryContext,
  deps: SmartRecoveryDependencies
): Promise<AuthResult | null> {
  // Network issues → retry with backoff
  if (error.code === 'auth/network-request-failed') {
    toast('info', 'Connection issue - retrying...');
    try {
      return await retryWithBackoff(operation, deps);
    } catch (retryError) {
      throw handleError(retryError, {
        userMessage:
          'Network connection failed. Please check your internet and try again.',
        context: { operation: 'network-retry', originalError: error.code },
        showNotification: true,
      });
    }
  }

  // Rate limiting → exponential backoff
  if (error.code === 'auth/too-many-requests') {
    toast('info', 'Rate limited - retrying with backoff...');
    try {
      return await retryWithExponentialBackoff(operation, deps);
    } catch (retryError) {
      throw handleError(retryError, {
        userMessage: 'Too many attempts. Please wait a moment and try again.',
        context: { operation: 'rate-limit-retry', originalError: error.code },
        showNotification: true,
      });
    }
  }

  // Internal errors → retry with delay
  if (error.code === 'auth/internal-error') {
    toast('info', 'Temporary issue - retrying...');
    try {
      return await retryWithDelay(operation, deps);
    } catch (retryError) {
      throw handleError(retryError, {
        userMessage: 'A temporary error occurred. Please try again.',
        context: {
          operation: 'internal-error-retry',
          originalError: error.code,
        },
        showNotification: true,
      });
    }
  }

  // Account linking → handle linking
  if (error.code === 'auth/account-exists-with-different-credential') {
    try {
      return await deps.handleAccountLinking(
        error,
        context.partnerId!,
        context.method ? getAuthMethod(context.method) : getAuthMethod()
      );
    } catch (linkingError) {
      throw handleError(linkingError, {
        userMessage: 'Failed to link accounts. Please try again.',
        context: { operation: 'account-linking', originalError: error.code },
        showNotification: true,
      });
    }
  }

  // User cancellation → return null (not an error)
  if (
    error.code === 'auth/popup-closed-by-user' ||
    error.code === 'auth/cancelled-popup-request' ||
    error.code === 'auth/popup-blocked'
  ) {
    return null;
  }

  // Can't handle → wrap and throw
  throw handleError(error, {
    userMessage: getErrorMessage(error.code),
    context: { operation: 'smart-recovery', errorCode: error.code },
    showNotification: true,
  });
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
  operation: () => Promise<any>,
  deps: SmartRecoveryDependencies,
  maxRetries = 3
): Promise<AuthResult | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await operation();
      return deps.createAuthResult(result.user);
    } catch (error: any) {
      if (
        attempt === maxRetries ||
        error.code !== 'auth/network-request-failed'
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
  operation: () => Promise<any>,
  deps: SmartRecoveryDependencies,
  maxRetries = 3
): Promise<AuthResult | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await operation();
      return deps.createAuthResult(result.user);
    } catch (error: any) {
      if (attempt === maxRetries || error.code !== 'auth/too-many-requests') {
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
  operation: () => Promise<any>,
  deps: SmartRecoveryDependencies,
  maxRetries = 2
): Promise<AuthResult | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await operation();
      return deps.createAuthResult(result.user);
    } catch (error: any) {
      if (attempt === maxRetries || error.code !== 'auth/internal-error') {
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
function getErrorMessage(errorCode: string): string {
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

  return errorMessages[errorCode] || 'An authentication error occurred';
}
