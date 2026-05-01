// packages/providers/firebase/src/server/index.ts

/**
 * @fileoverview Firebase server SDK barrel exports
 * @description Server-only Firebase operations using Admin SDK. Provides server-side authentication, Firestore operations, batch processing, validation, and subscription management. Uses Firebase Admin SDK for privileged operations in Node.js environments only.
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

export * from './authAdapter';
export * from './init';
export * from './utils';
export * from './batch';
export * from './subscription';
export * from './validation';
export * from './uniqueness';

// Re-export shared transform utilities for server use
export * from '../shared/transform';

// Re-export Firestore types and constants for convenience
export { FieldValue, Query, Timestamp } from 'firebase-admin/firestore';
