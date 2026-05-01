// packages/providers/firebase/src/shared/types.ts

/**
 * @fileoverview Firebase shared types
 * @description Common type definitions for Firebase operations. Defines interfaces and types used across both client and server Firebase implementations for consistency and type safety.
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

/**
 * Firebase configuration interface
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
  /** Firebase measurement ID for analytics (optional) */
  measurementId?: string;
}
