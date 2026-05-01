# @donotdev/firebase

Firebase utilities for DoNotDev applications. This package provides a clean separation between client-safe and server-only Firebase functions.

## Structure

This package is split into two main parts:

### Client-Safe Exports (Default)

Import from the main package for client-safe functions:

```typescript
import { initFirebase, getAuth } from '@donotdev/firebase';
import { getFirestore } from '@donotdev/firebase/server';
```

**Available modules:**

- `auth.ts` - Authentication utilities
- `init.ts` - Firebase initialization
- `transform.ts` - Data transformation utilities
- `utils.ts` - Client-safe utility functions
- `validation.ts` - Client-safe validation functions
- `uniqueness.ts` - Uniqueness validation (client-safe functions only)

### Server-Only Exports

Import from the server subpath for server-only functions:

```typescript
import { batchWrite, getActiveSubscription } from '@donotdev/firebase/server';
```

**Available modules:**

- `batch.ts` - Batch operations (create, update, delete)
- `subscription.ts` - Subscription management
- `server/utils.ts` - Server-only utilities
- `validation.ts` - Server-only validation functions
- `uniqueness.ts` - Server-only uniqueness functions

## Features

- **Data Transformation**: Convert between Firestore and application formats
- **Uniqueness Validation**: Enforce field uniqueness constraints
- **Schema Validation**: Validate documents against schemas
- **Batch Operations**: Efficiently handle multiple document operations
- **Authentication**: Type-safe auth utilities with standard error handling
- **Initialization**: Simple configuration with environment variable support

## Installation

```bash
bun add @donotdev/firebase
```

## Usage Examples

### Client-Side (Browser/SSR)

```typescript
import { initFirebase, getAuth } from '@donotdev/firebase';

// Initialize Firebase
const { app, auth } = initFirebase();

// Use client SDK
const user = auth?.currentUser;
```

### Server-Side (API Routes, Server Actions)

```typescript
import { batchWrite, getActiveSubscription } from '@donotdev/firebase/server';

// Batch operations
const result = await batchWrite('users', users, 'create');

// Subscription management
const subscription = await getActiveSubscription(userId);
```

### Data Transformation

```typescript
import {
  transformFirestoreData,
  prepareForFirestore,
} from '@donotdev/firebase';

// Convert Firestore Timestamps to ISO strings
const appData = transformFirestoreData(firestoreData);

// Convert ISO strings to Firestore Timestamps
const firestoreData = prepareForFirestore(appData);
```

### Schema Validation

```typescript
import { enhanceSchema, validateCreate } from '@donotdev/firebase';
import * as v from 'valibot';

// Create a schema with uniqueness constraints
const userSchema = enhanceSchema(
  v.object({
    email: z.string().email(),
    username: z.string().min(3),
    createdAt: z.string().datetime(),
  }),
  {
    collection: 'users',
    uniqueFields: [
      { field: 'email', errorMessage: 'Email is already in use' },
      { field: 'username', errorMessage: 'Username is taken' },
    ],
  }
);

// Validate a document before saving
try {
  await validateCreate(userSchema, userData);
  // Document is valid, proceed with saving
} catch (error) {
  // Handle validation errors
  console.error('Validation failed:', error);
}
```

### Batch Operations

```typescript
import { batchCreate, batchUpdate, batchDelete } from '@donotdev/firebase';

// Create multiple documents
const createResult = await batchCreate('products', products);
console.log(
  `Created ${createResult.successes} products with ${createResult.failures} failures`
);

// Update multiple documents
const updateResult = await batchUpdate('products', updatedProducts);

// Delete multiple documents
const deleteResult = await batchDelete('products', productIds, {
  idField: 'id',
});
```

### Authentication

The Firebase SDK automatically handles `authDomain` configuration using a dynamic approach:

- **Client-Side (CSR)**: Uses `window.location.hostname` for same-origin authentication
- **Server-Side (SSR)**: Uses `APP_URL` environment variable hostname
- **Localhost**: Falls back to `${projectId}.firebaseapp.com` for Firebase infrastructure

No manual `authDomain` configuration required - the SDK handles this automatically.

```typescript
import {
  signInWithEmail,
  signInWithGoogle,
  getCurrentUser,
  signOut,
  getIdToken,
} from '@donotdev/firebase';

// Sign in with email/password
const user = await signInWithEmail('user@example.com', 'password');

// Sign in with Google
const user = await signInWithGoogle();

// Get current user
const currentUser = getCurrentUser();

// Get authentication token
const token = await getIdToken();

// Sign out
await signOut();
```

### Initialization

```typescript
import { initFirebase } from '@donotdev/firebase';

// Initialize Firebase from environment variables
const { app, auth, firestore } = initFirebase();

// Or with custom configuration
const { app, auth, firestore } = initFirebase({
  apiKey: 'your-api-key',
  authDomain: 'your-project.firebaseapp.com',
  projectId: 'your-project-id',
  // ...other config
});

// Use emulators for development
const { app, auth, firestore } = initFirebase(undefined, true);
```

## Key Benefits

1. **No Client Bundling Issues**: Server-only functions are never bundled in client builds
2. **Clear Separation**: Easy to understand what's safe for client vs server
3. **Type Safety**: Full TypeScript support for both client and server functions
4. **Framework Agnostic**: Works with Next.js, Vite, and other frameworks

## Migration Guide

If you were previously importing server functions from the main package:

**Before:**

```typescript
import { batchWrite } from '@donotdev/firebase';
```

**After:**

```typescript
import { batchWrite } from '@donotdev/firebase/server';
```

## Environment Variables

Required for client initialization:

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_PROJECT_ID`

Optional:

- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`
- `VITE_FIREBASE_MEASUREMENT_ID`

## Demo Mode

The package includes a demo mode that activates when Firebase configuration is missing. This allows development without Firebase setup.

```typescript
import { isFirebaseDemoMode } from '@donotdev/firebase';

if (isFirebaseDemoMode()) {
  console.log('Running in demo mode');
}
```

## Integration with DoNotDev

This package integrates seamlessly with other DoNotDev packages:

- Use with `@donotdev/schemas` for complete entity validation
- Pair with `@donotdev/hooks` for type-safe data access
- Works with `@donotdev/auth` for comprehensive authentication

## Core Modules

### transform.ts

Data transformation utilities for converting between Firestore and application formats.

- `transformFirestoreData`: Converts Timestamps to ISO strings
- `prepareForFirestore`: Converts ISO strings to Timestamps
- `toTimestamp`: Converts Date or ISO string to Firestore Timestamp
- `toISOString`: Converts DateValue to ISO string
- `createFirestorePartialUpdate`: Creates a diff for partial updates

### validation.ts

Document validation against schemas with uniqueness constraints.

- `validateFirestoreDocument`: Validates document against schema and checks uniqueness
- `validateCreate`: Validates document for creation
- `validateUpdate`: Validates document for update
- `enhanceSchema`: Adds Firestore metadata to schema

### uniqueness.ts

Uniqueness constraint validation to ensure field values are unique.

- `validateUniqueness`: Validates uniqueness constraints for a document
- `createFirestoreValidator`: Server-side validator for uniqueness
- `createFirestoreClientValidator`: Client-side validator for uniqueness

### batch.ts

Utilities for batch operations with automatic chunking.

- `batchWrite`: Generic batch write operation
- `batchCreate`: Creates multiple documents
- `batchUpdate`: Updates multiple documents
- `batchDelete`: Deletes multiple documents
- `bulkGet`: Fetches multiple documents by ID

### auth.ts

Authentication utilities for client-side operations.

- `signInWithEmail`: Signs in with email and password
- `signInWithGoogle`: Signs in with Google
- `resetPassword`: Sends password reset email
- `getCurrentUser`: Gets current authenticated user
- `getIdToken`: Gets authentication token
- `signOut`: Signs out current user
- `isCurrentUserAdmin`: Checks if current user has admin role

### utils.ts

Core utilities for Firebase operations.

- `handleFirebaseError`: Standardizes Firebase errors
- `generateId`: Generates unique IDs for documents
- `executeFirebaseOperation`: Executes operation with retry support

### init.ts

Initialization utilities for Firebase in different environments.

- `initFirebase`: Initializes Firebase from environment variables or config
- `initAdminApp`: Initializes Firebase Admin SDK

## Best Practices

1. Always transform data when crossing the Firebase boundary:

   ```typescript
   // Before saving to Firestore
   const firestoreData = prepareForFirestore(appData);

   // After fetching from Firestore
   const appData = transformFirestoreData(firestoreData);
   ```

2. Use batch operations for multiple documents:

   ```typescript
   // Instead of multiple individual writes
   await batchCreate('products', newProducts);
   ```

3. Handle errors consistently:

   ```typescript
   try {
     // Firebase operation
   } catch (error) {
     throw handleFirebaseError(error, 'Operation name');
   }
   ```

4. Enforce uniqueness constraints:

   ```typescript
   const schema = enhanceSchema(productSchema, {
     collection: 'products',
     uniqueFields: [{ field: 'sku', errorMessage: 'SKU already exists' }],
   });
   ```

5. For server environments, initialize validator early:

   ```typescript
   import { createFirestoreValidator } from '@donotdev/firebase/server';

   async function initializeApp() {
     // Set up validator once at app startup
     await createFirestoreValidator();
   }
   ```

## 📄 License & Ownership

All rights reserved.  
The DoNotDev framework and its premium features are the exclusive property of **Ambroise Park Consulting**.

- Licensed under MIT. See LICENSE.md.

© Ambroise Park Consulting – 2025
