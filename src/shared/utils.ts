// packages/providers/firebase/src/shared/utils.ts

/**
 * @fileoverview Firebase utility functions
 * @description Core utility functions for Firebase integration
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import type { FirebaseCallOptions } from '@donotdev/core';
import { handleError } from '@donotdev/core';

/**
 * Creates an abort controller with timeout
 * @param options Timeout and related options
 * @returns AbortController with appropriate timeout
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function createAbortController(options?: FirebaseCallOptions): {
  controller: AbortController;
  timeoutId: ReturnType<typeof setTimeout> | undefined;
} {
  const controller = new AbortController();

  // Apply timeout if specified
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  if (options?.timeout) {
    timeoutId = setTimeout(() => {
      controller.abort(
        handleError(new Error('Request timeout exceeded'), {
          userMessage: 'The operation timed out',
          context: { timeoutMs: options.timeout, abortKey: options.abortKey },
        })
      );
    }, options.timeout);
  }

  // Link with external signal if provided
  if (options?.externalSignal) {
    options.externalSignal.addEventListener('abort', () => {
      controller.abort(options.externalSignal?.reason || 'External abort');
    });
  }

  // Clean up on abort (covers timeout-triggered and external-signal-triggered aborts)
  controller.signal.addEventListener('abort', () => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  });

  // Item 54: return timeoutId so callers can clearTimeout on success
  return { controller, timeoutId };
}

/**
 * Handles Firebase errors consistently using the central error handler
 * @param error The original Firebase error
 * @param context Optional context about the operation
 * @returns An error handled through the central system
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function handleFirebaseError(error: any, context?: string): Error {
  return handleError(error, {
    userMessage: context ? `Error during ${context}` : undefined,
    context: { operation: context },
  });
}

/**
 * Executes a Firebase operation with automatic retry for retryable errors
 * @param operation Name of the operation for logging
 * @param fn Function to execute
 * @param options Options for retry behavior
 * @returns Result of the operation
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function executeFirebaseOperation<T>(
  operation: string,
  fn: () => Promise<T>,
  options: {
    retry?: boolean;
    maxRetries?: number;
    retryDelay?: number;
  } = {}
): Promise<T> {
  const { retry = false, maxRetries = 3, retryDelay = 300 } = options;

  let attempt = 0;

  while (true) {
    try {
      // Execute the operation
      return await fn();
    } catch (error) {
      // Increment attempt counter
      attempt++;

      // Should we retry?
      const isRetryable =
        isRetryableError(error) && retry && attempt <= maxRetries;

      if (isRetryable) {
        // Exponential backoff
        const delay = retryDelay * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      // Use server error handler
      throw handleError(error, {
        userMessage: `Firebase operation "${operation}" failed`,
        context: { operation, attempt, maxRetries, options },
      });
    }
  }
}

/**
 * Determines if an error is retryable
 * Uses general patterns rather than specific code mapping
 * @param error The error to check
 * @returns Whether the error is eligible for retry
 */
function isRetryableError(error: any): boolean {
  // Non-retryable standard error codes
  const nonRetryableCodes = [
    'permission-denied',
    'invalid-argument',
    'already-exists',
    'not-found',
    'unauthenticated',
  ];

  // Check if it's already been handled by central system
  if (
    error &&
    error.name === 'DoNotDevError' &&
    nonRetryableCodes.includes(error.code)
  ) {
    return false;
  }

  // Firebase-specific error codes - just check patterns
  // The actual mapping will be done by the central system
  if (error && error.code) {
    // Network/server errors are retryable
    const retryablePatterns = [
      'unavailable',
      'deadline',
      'cancel',
      'network',
      'timeout',
      'internal',
      'resource',
      'exhausted',
    ];

    return retryablePatterns.some((pattern) =>
      error.code.toLowerCase().includes(pattern)
    );
  }

  // Default to retryable for unknown errors
  return true;
}
