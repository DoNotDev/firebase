// packages/providers/firebase/src/shared/transform.ts

/**
 * @fileoverview Firebase data transformation utilities
 * @description Functions for converting data between Firebase and application formats. Handles timestamp conversion, data preparation, and transformation for Firestore operations.
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import type { DateValue, FirestoreTimestamp } from '@donotdev/core';
import { handleError } from '@donotdev/core';

/**
 * Create a client-safe version of the Timestamp creation
 * This is a browser-compatible replacement for the Timestamp.fromDate() method
 * @param date - The Date object to convert
 * @returns A representation of the timestamp
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function createTimestamp(date: Date): FirestoreTimestamp {
  return {
    seconds: Math.floor(date.getTime() / 1000),
    nanoseconds: (date.getTime() % 1000) * 1000000,
    toDate: () => new Date(date),
    toMillis: () => date.getTime(),
    isEqual: (other: FirestoreTimestamp) =>
      other.seconds === Math.floor(date.getTime() / 1000) &&
      other.nanoseconds === (date.getTime() % 1000) * 1000000,
    valueOf: () =>
      `Timestamp(seconds=${Math.floor(date.getTime() / 1000)}, nanoseconds=${(date.getTime() % 1000) * 1000000})`,
  };
}

/**
 * Converts a Date or ISO string to a Firestore Timestamp.
 * @param date - The date to convert (string or Date)
 * @returns The Firestore Timestamp
 * @throws Error if the date is invalid
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function toTimestamp(date: string | Date): FirestoreTimestamp {
  try {
    if (typeof date === 'string') {
      const parsed = new Date(date);
      if (isNaN(parsed.getTime())) {
        throw handleError(new Error('Invalid date string format'), {
          context: { value: date },
        });
      }
      return createTimestamp(parsed);
    }
    if (date instanceof Date) {
      if (isNaN(date.getTime())) {
        throw handleError(new Error('Invalid Date object'), {
          context: { value: date },
        });
      }
      return createTimestamp(date);
    }
    throw handleError(new Error('Invalid date value type'), {
      context: { valueType: typeof date },
    });
  } catch (error) {
    throw handleError(error, 'Failed to convert to Timestamp');
  }
}

/**
 * Converts a DateValue to an ISO string.
 * @param date - The date value to convert (Date, Timestamp, or ISO string)
 * @returns The ISO string representation
 * @throws Error if the date is invalid
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function firestoreToISOString(date: DateValue): string {
  try {
    if (date instanceof Date) {
      if (isNaN(date.getTime())) {
        throw handleError(new Error('Invalid Date object'), {
          context: { value: date },
        });
      }
      return date.toISOString();
    }

    if (
      typeof date === 'object' &&
      date !== null &&
      'toDate' in date &&
      typeof date.toDate === 'function'
    ) {
      return date.toDate().toISOString();
    }

    if (typeof date === 'string') {
      const parsed = new Date(date);
      if (isNaN(parsed.getTime())) {
        throw handleError(new Error('Invalid date string format'), {
          context: { value: date },
        });
      }
      return parsed.toISOString();
    }

    throw handleError(new Error('Invalid date value type'), {
      context: { valueType: typeof date },
    });
  } catch (error) {
    throw handleError(error, 'Failed to convert to ISO string');
  }
}

/**
 * Type guard to check if an object is a Firestore Timestamp
 * @param value - The value to check
 * @returns True if the value is a Firestore Timestamp
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function isTimestamp(value: any): value is FirestoreTimestamp {
  return (
    typeof value === 'object' &&
    value !== null &&
    'toDate' in value &&
    typeof value.toDate === 'function' &&
    'seconds' in value &&
    'nanoseconds' in value
  );
}

/**
 * Checks if a string is an ISO date string
 * @param str - The string to check
 * @returns True if the string is an ISO date
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
function isISODateString(str: string): boolean {
  if (typeof str !== 'string') return false;
  const isoDatePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
  if (!isoDatePattern.test(str)) return false;
  const date = new Date(str);
  return !isNaN(date.getTime());
}

/**
 * Recursively converts ISO date strings to Date objects for schema validation.
 * Schema validation expects Date objects for timestamp fields, not ISO strings.
 * @param data - The data to convert
 * @returns The data with ISO strings converted to Date objects
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function convertISOStringsToDates<T = any>(data: T): T {
  if (!data) return data;

  if (Array.isArray(data)) {
    return data.map((item) => convertISOStringsToDates(item)) as unknown as T;
  }

  if (typeof data === 'string' && isISODateString(data)) {
    return new Date(data) as unknown as T;
  }

  if (typeof data === 'object' && data !== null) {
    const converted: Record<string, any> = {};
    for (const [key, value] of Object.entries(data as Record<string, any>)) {
      converted[key] = convertISOStringsToDates(value);
    }
    return converted as T;
  }

  return data;
}

/**
 * Recursively transforms Firestore data by converting Timestamps to ISO strings.
 * @param data - The data to transform
 * @param includeDocumentIds - Whether to include document IDs from doc.id
 * @returns The transformed data
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function transformFirestoreData<T = any>(
  data: T,
  includeDocumentIds: boolean = false
): T {
  if (!data) return data;

  // Handle Firestore document with ID
  if (
    includeDocumentIds &&
    typeof data === 'object' &&
    data !== null &&
    'id' in data &&
    'ref' in data &&
    'data' in data &&
    typeof (data as any).data === 'function'
  ) {
    const doc = data as any;
    const documentData = doc.data();
    return {
      id: doc.id,
      ...transformFirestoreData(documentData),
    } as T;
  }

  // Handle arrays
  if (Array.isArray(data)) {
    return data.map((item) => transformFirestoreData(item)) as unknown as T;
  }

  // Handle Timestamps
  if (isTimestamp(data)) {
    return firestoreToISOString(data) as unknown as T;
  }

  // Handle objects recursively
  if (typeof data === 'object' && data !== null) {
    const transformed: Record<string, any> = {};
    for (const [key, value] of Object.entries(data as Record<string, any>)) {
      transformed[key] = transformFirestoreData(value);
    }
    return transformed as T;
  }

  // Return primitive values unchanged
  return data;
}

/**
 * Recursively prepares data for Firestore by converting Date objects to ISO strings.
 * ISO strings are kept as-is (no conversion needed).
 * @param data - The data to prepare
 * @param removeFields - Optional array of field names to remove
 * @returns The prepared data
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function prepareForFirestore<T = any>(
  data: T,
  removeFields: string[] = []
): T {
  if (!data) return data;

  // Handle arrays
  if (Array.isArray(data)) {
    return data.map((item) =>
      prepareForFirestore(item, removeFields)
    ) as unknown as T;
  }

  // Handle Date objects - convert to ISO string
  if (data instanceof Date) {
    return data.toISOString() as unknown as T;
  }

  // ISO strings stay as strings - no conversion needed

  // Handle objects recursively
  if (typeof data === 'object' && data !== null) {
    const prepared: Record<string, any> = {};
    for (const [key, value] of Object.entries(data as Record<string, any>)) {
      // Skip fields that should be removed
      if (removeFields.includes(key)) {
        continue;
      }

      // Skip undefined values (Firestore doesn't accept them)
      if (value === undefined) {
        continue;
      }

      prepared[key] = prepareForFirestore(value, removeFields);
    }
    return prepared as T;
  }

  // Return primitive values unchanged
  return data;
}

/**
 * Creates a data diff between original and updated data for partial updates
 * @param original - Original data
 * @param updated - Updated data
 * @returns Object containing only the changed fields and their new values
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function createFirestorePartialUpdate<T extends Record<string, any>>(
  original: T,
  updated: Partial<T>
): Partial<T> {
  const diff: Partial<T> = {};

  // Track only changes
  for (const [key, value] of Object.entries(updated)) {
    // Skip if key doesn't exist in original
    if (!(key in original)) {
      diff[key as keyof T] = value;
      continue;
    }

    // Add field to diff if value has changed
    if (JSON.stringify(original[key]) !== JSON.stringify(value)) {
      diff[key as keyof T] = value;
    }
  }

  // Add standard update timestamp
  return {
    ...diff,
    updatedAt: new Date().toISOString(),
  };
}
