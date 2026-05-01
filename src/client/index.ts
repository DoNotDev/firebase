// packages/providers/firebase/src/client/index.ts

/**
 * @fileoverview Firebase client SDK barrel exports
 * @description Browser-safe Firebase operations using client SDK. Exports Auth SDK and Firestore SDK functions for client-side use.
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

// Export Auth SDK functions
export * from './sdk';

// Export Firestore SDK functions
export * from './firestore';

// Export Functions SDK functions
export * from './functions';

// Export Storage SDK functions
export * from './storage';

// Export Storage Adapter (IStorageAdapter implementation)
export * from './storageAdapter';

// Export Callable Provider (ICallableProvider implementation)
export * from './callableProvider';

// Export Firestore CRUD Adapter (ICrudAdapter implementation)
export * from './FirestoreAdapter';

// Export Firebase Auth Orchestrator
export { FirebaseAuth, getFirebaseAuth } from './FirebaseAuth';
