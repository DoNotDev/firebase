// packages/providers/firebase/src/server/validation.ts

/**
 * @fileoverview Firebase server validation
 * @description Document validation utilities using server-side Firebase Admin SDK. Provides document validation, uniqueness validation, and schema validation for Firestore operations.
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import type { dndevSchema, UniqueConstraintValidator } from '@donotdev/core';
import { handleError } from '@donotdev/core/server';

import { validateUniqueness } from './uniqueness';

// Re-export uniqueness functions from dedicated module
export {
  validateUniqueness,
  registerUniqueConstraintValidator,
  getUniqueConstraintValidator,
  hasUniqueConstraintValidator,
  createFirestoreValidator,
  createAdminFirestoreValidator,
  createFirestoreClientValidator,
} from './uniqueness';

/**
 * Validates a Firestore document against its schema with enhanced checks
 * @param schema - The Valibot schema to validate against
 * @param data - The document data to validate
 * @param operation - Whether this is a create or update operation
 * @param currentDocId - Current document ID (for updates)
 * @throws {Error} - If validation fails
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function validateFirestoreDocument<T>(
  schema: dndevSchema<T>,
  data: Record<string, any>,
  operation: 'create' | 'update',
  currentDocId?: string
): Promise<void> {
  try {
    // Standard schema validation
    v.parse(schema, data);

    // Uniqueness validation if metadata has uniqueFields
    if (schema.metadata?.uniqueFields?.length) {
      await validateUniqueness(
        schema.metadata.collection,
        schema.metadata.uniqueFields,
        data,
        currentDocId
      );
    }

    // Custom validation hook if defined on schema
    if (schema.metadata?.customValidate) {
      await schema.metadata.customValidate(data, operation);
    }
  } catch (error: unknown) {
    // NW1 fix: use v.isValiError() instead of duck-typing on `error: any`
    if (v.isValiError(error)) {
      // Handle Valibot validation errors
      throw handleError(error, {
        userMessage: 'Document validation failed',
        context: {
          validationErrors: error.issues,
          data,
        },
        severity: 'warning',
      });
    }

    // Re-throw non-Valibot errors
    throw handleError(error, {
      userMessage: 'Document validation failed',
      context: {
        collection: schema.metadata?.collection || 'unknown',
      },
      severity: 'error',
    });
  }
}

/**
 * Enhances a Valibot schema with Firestore metadata
 *
 * @param schema Base Valibot schema
 * @param metadata Firestore-specific metadata
 * @returns Enhanced schema
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function enhanceSchema<T>(
  schema: v.BaseSchema<unknown, T, v.BaseIssue<unknown>>,
  metadata: {
    collection: string;
    uniqueFields?: Array<{
      field: string;
      errorMessage?: string;
    }>;
    customValidate?: (
      data: Record<string, any>,
      operation: 'create' | 'update'
    ) => Promise<void>;
  }
): dndevSchema<T> {
  const enhanced = schema as dndevSchema<T>;
  enhanced.metadata = metadata;
  return enhanced;
}
