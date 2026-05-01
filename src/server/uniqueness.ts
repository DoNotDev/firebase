// packages/providers/firebase/src/server/uniqueness.ts

/**
 * @fileoverview Firebase server uniqueness validation
 * @description Implementation of uniqueness constraint validation for Firestore. Provides validation and registration of unique constraint validators for server-side operations.
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import type { UniqueConstraintValidator } from '@donotdev/core';
import { handleError } from '@donotdev/core/server';

import { getServerFirestore } from './utils';

/**
 * Registry for uniqueness constraint validators
 */
const validatorRegistry: {
  uniqueConstraintValidator?: UniqueConstraintValidator;
} = {};

/**
 * Registers a validator for uniqueness constraints
 * @param validator - The validator implementation
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function registerUniqueConstraintValidator(
  validator: UniqueConstraintValidator
): void {
  validatorRegistry.uniqueConstraintValidator = validator;
}

/**
 * Gets the currently registered uniqueness constraint validator
 * @returns The registered validator or undefined if none is registered
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function getUniqueConstraintValidator():
  | UniqueConstraintValidator
  | undefined {
  return validatorRegistry.uniqueConstraintValidator;
}

/**
 * Checks if a uniqueness validator is registered
 * @returns True if a validator is registered, false otherwise
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function hasUniqueConstraintValidator(): boolean {
  return !!validatorRegistry.uniqueConstraintValidator;
}

/**
 * Creates a Firestore validator for uniqueness constraints in server environments
 * @returns A Firestore-based uniqueness constraint validator
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function createFirestoreValidator(): Promise<UniqueConstraintValidator> {
  // C2 fix: let initialization errors propagate — callers must handle them explicitly.
  // A silent no-op would bypass all uniqueness checks on transient infra failures.
  const db = await getServerFirestore();

  const validator: UniqueConstraintValidator = {
    checkDuplicate: async (
      collection: string,
      field: string,
      value: any,
      currentDocId?: string
    ) => {
      // Handle null/undefined values (they can't be unique constraints)
      if (value === null || value === undefined) {
        return false;
      }

      try {
        const query = db.collection(collection).where(field, '==', value);
        const snapshot = await query.get();

        // Check if any document (except the current one) has the same value
        return snapshot.docs.some(
          (doc: { id: string; data: () => Record<string, unknown> }) =>
            doc.id !== currentDocId && doc.data()[field] === value
        );
      } catch (error) {
        throw handleError(error, {
          userMessage: `Failed to check uniqueness for field "${field}"`,
          severity: 'error',
          context: { collection, field, value },
        });
      }
    },
  };

  // Register the validator
  registerUniqueConstraintValidator(validator);
  return validator;
}

/**
 * Creates an Admin SDK Firestore validator for server-side uniqueness checks.
 * Renamed from createFirestoreClientValidator — C1 fix: the old name was misleading;
 * this function exclusively uses the Firebase Admin SDK and must never run in a browser.
 * @returns An Admin Firestore uniqueness constraint validator
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function createAdminFirestoreValidator(): Promise<UniqueConstraintValidator> {
  // C1 fix: renamed from createFirestoreClientValidator — this uses Admin SDK (server-only).
  // C2 fix: let initialization errors propagate instead of returning a silent no-op.
  const db = await getServerFirestore();

  const validator: UniqueConstraintValidator = {
    checkDuplicate: async (
      collectionName: string,
      field: string,
      value: any,
      currentDocId?: string
    ) => {
      // Handle null/undefined values (they can't be unique constraints)
      if (value === null || value === undefined) {
        return false;
      }

      try {
        const collectionRef = db.collection(collectionName);
        const querySnapshot = await collectionRef
          .where(field, '==', value)
          .get();

        // Check if any document (except the current one) has the same value
        return querySnapshot.docs.some(
          (doc: any) => doc.id !== currentDocId && doc.data()[field] === value
        );
      } catch (error) {
        throw handleError(error, {
          userMessage: `Failed to check uniqueness for field "${field}"`,
          severity: 'error',
          context: { collection: collectionName, field, value },
        });
      }
    },
  };

  // Register the validator
  registerUniqueConstraintValidator(validator);
  return validator;
}

/**
 * @deprecated Use createAdminFirestoreValidator instead.
 * This alias is kept for backwards compatibility and will be removed in a future version.
 */
export const createFirestoreClientValidator = createAdminFirestoreValidator;

/**
 * Validates uniqueness constraints for a document
 * @param collection Collection name
 * @param constraints Array of field constraints to check
 * @param data Document data
 * @param currentDocId Current document ID (for updates)
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function validateUniqueness(
  collection: string,
  constraints: Array<{
    field: string;
    errorMessage?: string;
  }>,
  data: Record<string, any>,
  currentDocId?: string
): Promise<void> {
  if (!constraints.length) return;

  // Ensure we have a validator
  let validator = getUniqueConstraintValidator();
  if (!validator) {
    // C1 fix: uniqueness.ts is server-only — always use the Admin SDK validator.
    validator = await createFirestoreValidator();
  }

  // Check each constraint
  const errors: Array<{ field: string; message: string }> = [];

  // NW8 fix: use Promise.allSettled so a single check failure doesn't silently
  // discard results from other checks. Re-throw the first rejection if any occurred.
  const settlements = await Promise.allSettled(
    constraints.map(async ({ field, errorMessage }) => {
      const value = data[field];
      if (value === undefined || value === null) return;

      const isDuplicate = await validator!.checkDuplicate(
        collection,
        field,
        value,
        currentDocId
      );

      if (isDuplicate) {
        errors.push({
          field,
          message: errorMessage || `The ${field} must be unique`,
        });
      }
    })
  );

  // Surface the first infrastructure error from any check
  const firstRejection = settlements.find((s) => s.status === 'rejected');
  if (firstRejection && firstRejection.status === 'rejected') {
    throw firstRejection.reason;
  }

  // If we have any errors, throw with all the validation errors
  if (errors.length > 0) {
    throw handleError(new Error('Uniqueness validation failed'), {
      userMessage: 'Uniqueness validation failed',
      severity: 'error',
      context: {
        validationErrors: errors,
        collection,
      },
    });
  }
}
