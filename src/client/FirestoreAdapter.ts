// packages/providers/firebase/src/client/FirestoreAdapter.ts

/**
 * @fileoverview Firestore Backend Adapter
 * @description Direct Firestore SDK adapter for CRUD operations
 *
 * **Direct client access** — no functions layer. Register via `configureProviders({ crud: new FirestoreAdapter() })`.
 *
 * **Use cases:**
 * - User preferences, settings, client-only data
 * - Simple data that doesn't require server-side security
 * - Prototyping or development without functions
 *
 * **Note:** Adds technical fields (`createdAt`, `updatedAt`, `createdById`, `updatedById`) client-side
 * since there's no server to generate them. For production data with security requirements, use
 * `FunctionsAdapter` via `configureProviders({ crud: new FunctionsAdapter() })`.
 *
 * **Features:**
 * - Direct Firestore access (low latency)
 * - Real-time subscriptions
 * - Offline persistence
 * - Batch operations
 * - Schema validation
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import {
  BulkCollisionError,
  detectBulkCollisions,
  wrapCrudError,
  validateWithSchema,
  ensureSpreadable,
  getPlatformEnvVar,
} from '@donotdev/core';
import type {
  BulkOperations,
  BulkResult,
  CrudOperationOptions,
  dndevSchema,
  ICrudAdapter,
  QueryOptions,
  PaginatedQueryResult,
  ListSchemaType,
} from '@donotdev/core';

import {
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  collection,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  onSnapshot,
  writeBatch,
  transformFirestoreData,
  prepareForFirestore,
  type DocumentSnapshot,
  type QuerySnapshot,
  type QueryDocumentSnapshot,
  type CollectionReference,
  type QueryConstraint,
  type Unsubscribe,
  type FirestoreError,
  type WhereFilterOp,
  type OrderByDirection,
} from './firestore';
import { getFirebaseFirestore } from './firestore';
import { getFirebaseSDK } from './sdk';

import type { Firestore } from 'firebase/firestore';

/**
 * Subscription callback for document subscriptions
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export type SubscriptionCallback<T> = (data: T | null, error?: Error) => void;
/**
 * Subscription callback for collection subscriptions
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export type CollectionSubscriptionCallback<T> = (
  data: T[],
  error?: Error
) => void;

/**
 * Firestore backend adapter
 * Works with any collection dynamically (collection name passed per operation)
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export class FirestoreAdapter implements ICrudAdapter {
  private firestore: Firestore | undefined;

  private firestoreInitPromise: Promise<boolean> | null = null;

  private async ensureFirestore(): Promise<boolean> {
    if (this.firestore) {
      return true;
    }
    if (this.firestoreInitPromise) return this.firestoreInitPromise;
    this.firestoreInitPromise = getFirebaseFirestore()
      .then((fs) => {
        this.firestore = fs;
        this.firestoreInitPromise = null;
        return true;
      })
      .catch(() => {
        this.firestoreInitPromise = null;
        // W7 fix: warn in dev so developers know Firestore operations are silently skipped
        if (getPlatformEnvVar('NODE_ENV') !== 'production') {
          console.warn(
            '[FirestoreAdapter] Firestore initialization failed — operations will be silently skipped. Check Firebase config.'
          );
        }
        return false;
      });
    return this.firestoreInitPromise;
  }

  private async requireFirestore(
    operation: string,
    collectionName: string
  ): Promise<Firestore> {
    // W7 fix: write operations must throw when Firestore is unavailable rather than
    // silently returning undefined/empty — silent no-ops hide data loss bugs.
    if ((await this.ensureFirestore()) && this.firestore) return this.firestore;
    throw wrapCrudError(
      new Error('Firestore not initialized'),
      'FirestoreAdapter',
      operation,
      collectionName
    );
  }

  private async getCollectionRef(
    collectionName: string
  ): Promise<CollectionReference | null> {
    if (!(await this.ensureFirestore()) || !this.firestore) return null;
    return collection(this.firestore, collectionName);
  }

  async get<T>(
    collectionName: string,
    id: string,
    schema?: dndevSchema<unknown>
  ): Promise<T | null> {
    if (!(await this.ensureFirestore()) || !this.firestore) return null;
    try {
      const docRef = doc(this.firestore, collectionName, id);
      const snapshot = await getDoc(docRef);
      if (!snapshot.exists()) return null;

      let data = snapshot.data();
      if (!data) return null;

      data = transformFirestoreData(data);
      const parsed = schema
        ? validateWithSchema(schema, data, 'FirestoreAdapter.get')
        : (data as Record<string, unknown>);
      // Include document ID in result
      return { ...ensureSpreadable(parsed), id } as T;
    } catch (error) {
      // Distinguish "not found" from real errors
      // Firestore returns null for non-existent docs, but network/auth errors should throw
      if (error instanceof Error && error.message?.includes('not found')) {
        return null;
      }
      throw wrapCrudError(error, 'FirestoreAdapter', 'get', collectionName, id);
    }
  }

  async set<T>(
    collectionName: string,
    id: string,
    data: T,
    schema: dndevSchema<T>
  ): Promise<void> {
    // W7 fix: throw instead of silent no-op when Firestore is unavailable
    const fs = await this.requireFirestore('set', collectionName);
    try {
      const validated = validateWithSchema(
        schema,
        data,
        'FirestoreAdapter.set'
      );
      const docRef = doc(fs, collectionName, id);
      const firestoreData = prepareForFirestore(validated) as any;
      await setDoc(docRef, firestoreData);
    } catch (error) {
      throw wrapCrudError(error, 'FirestoreAdapter', 'set', collectionName, id);
    }
  }

  async update<T>(
    collectionName: string,
    id: string,
    data: Partial<T>
  ): Promise<void> {
    // W7 fix: throw instead of silent no-op when Firestore is unavailable
    const fs = await this.requireFirestore('update', collectionName);
    try {
      const docRef = doc(fs, collectionName, id);
      const firestoreData = prepareForFirestore(data);
      await updateDoc(docRef, firestoreData);
    } catch (error) {
      throw wrapCrudError(
        error,
        'FirestoreAdapter',
        'update',
        collectionName,
        id
      );
    }
  }

  async delete(collectionName: string, id: string): Promise<void> {
    // W7 fix: throw instead of silent no-op when Firestore is unavailable
    const fs = await this.requireFirestore('delete', collectionName);
    try {
      const docRef = doc(fs, collectionName, id);
      await deleteDoc(docRef);
    } catch (error) {
      throw wrapCrudError(
        error,
        'FirestoreAdapter',
        'delete',
        collectionName,
        id
      );
    }
  }

  /**
   * Bulk transactional operation backed by Firestore's native `writeBatch()`.
   *
   * @description
   * Executes all inserts, updates and deletes in a single atomic commit — the
   * batch either lands in full or not at all. Runs entirely client-side; no
   * server function hop. Behavior:
   * - **Empty payload** (`{}`): returns a zeroed {@link BulkResult} without
   *   opening a batch.
   * - **Collision rejection**: if the same id appears in both `updates`+`deletes`
   *   or `inserts`+`updates`, throws {@link BulkCollisionError} before any write.
   * - **Validation**: when `schema` is provided, inserts and update patches are
   *   validated up-front. Any failure throws before the batch is committed.
   * - **Metadata**: inserts receive client-side `createdAt` / `updatedAt` /
   *   `createdById` / `updatedById`; update patches receive `updatedAt` /
   *   `updatedById`. Same policy as {@link FirestoreAdapter.add} and
   *   {@link FirestoreAdapter.update}. For server-signed metadata use
   *   `FunctionsAdapter`.
   * - **Order**: each id list in the returned {@link BulkResult} preserves the
   *   input order of the matching bucket.
   * - **Errors**: any underlying Firestore failure is wrapped via
   *   `wrapCrudError('FirestoreAdapter', 'bulk', collection)`.
   *
   * Per-op audit, rate-limit, optimistic cache and toast policies are the
   * service layer's concern — this adapter only guarantees "atomic commit,
   * returns ids".
   *
   * @param collectionName - Firestore collection name.
   * @param ops - Bulk payload. All three buckets optional.
   * @param schema - Optional entity schema used to validate inserts and update patches.
   * @param _options - Reserved; adapter ignores these today.
   * @returns `{ insertedIds, updatedIds, deletedIds }` in input order per bucket.
   *
   * @throws {BulkCollisionError} Same id in two mutually-exclusive buckets.
   *
   * @example
   * const adapter = new FirestoreAdapter();
   * const result = await adapter.bulk('events', {
   *   inserts: [{ title: 'A' }, { title: 'B' }],
   *   updates: [{ id: 'e1', patch: { title: 'renamed' } }],
   *   deletes: ['e2', 'e3'],
   * });
   * result.insertedIds.length; // 2
   * result.updatedIds;         // ['e1']
   * result.deletedIds;         // ['e2', 'e3']
   *
   * @version 0.1.0
   * @since 0.2.0
   * @author AMBROISE PARK Consulting
   */
  async bulk<T extends Record<string, unknown>>(
    collectionName: string,
    ops: BulkOperations<T>,
    schema?: dndevSchema<T>,
    _options?: CrudOperationOptions
  ): Promise<BulkResult> {
    const inserts = ops.inserts ?? [];
    const updates = ops.updates ?? [];
    const deletes = ops.deletes ?? [];

    // 1. Empty payload — no-op, no wire contact.
    if (inserts.length === 0 && updates.length === 0 && deletes.length === 0) {
      return { insertedIds: [], updatedIds: [], deletedIds: [] };
    }

    // 2. Collision rejection — fail loud before any write.
    const collision = detectBulkCollisions({
      inserts: inserts as Array<{ id?: string; [k: string]: unknown }>,
      updates: updates as Array<{ id: string; patch: unknown }>,
      deletes,
    });
    if (collision.where !== null) {
      throw new BulkCollisionError(collision.collisions, collision.where);
    }

    // 3. Ensure Firestore initialised — same guard as sibling write methods.
    const fs = await this.requireFirestore('bulk', collectionName);

    try {
      // 4. Up-front validation: inserts against full schema, update patches
      //    against the schema too (mirrors how single-row update trusts the
      //    caller — but validating here keeps bad patches out of the batch).
      const validatedInserts = inserts.map((row) =>
        schema
          ? validateWithSchema(schema, row, 'FirestoreAdapter.bulk')
          : (row as Record<string, unknown>)
      );
      const validatedUpdates = updates.map((u) => ({
        id: u.id,
        patch: schema
          ? (validateWithSchema(
              schema,
              u.patch,
              'FirestoreAdapter.bulk'
            ) as Partial<T>)
          : u.patch,
      }));

      // 5. Client-side metadata injection — identical policy to add/update.
      const now = new Date().toISOString();
      const userId = getFirebaseSDK().getCurrentUser()?.uid || 'anonymous';

      const insertsWithMetadata = validatedInserts.map((row) => ({
        ...(row as Record<string, unknown>),
        createdAt: now,
        updatedAt: now,
        createdById: userId,
        updatedById: userId,
      }));

      const updatesWithMetadata = validatedUpdates.map((u) => ({
        id: u.id,
        patch: {
          ...(u.patch as Record<string, unknown>),
          updatedAt: now,
          updatedById: userId,
        },
      }));

      // 6. Stage the batch — preserve input order across all three buckets.
      const batch = writeBatch(fs);
      const colRef = collection(fs, collectionName);

      const insertedIds: string[] = [];
      for (const payload of insertsWithMetadata) {
        const ref = doc(colRef);
        batch.set(ref, prepareForFirestore(payload) as any);
        insertedIds.push(ref.id);
      }

      const updatedIds: string[] = [];
      for (const u of updatesWithMetadata) {
        const ref = doc(fs, collectionName, u.id);
        batch.update(ref, prepareForFirestore(u.patch) as any);
        updatedIds.push(u.id);
      }

      const deletedIds: string[] = [];
      for (const id of deletes) {
        const ref = doc(fs, collectionName, id);
        batch.delete(ref);
        deletedIds.push(id);
      }

      // 7. Commit atomically.
      await batch.commit();

      // 8. Return ids in input order per bucket.
      return { insertedIds, updatedIds, deletedIds };
    } catch (error) {
      // Preserve BulkCollisionError identity if it somehow bubbled through here.
      if (error instanceof BulkCollisionError) throw error;
      throw wrapCrudError(error, 'FirestoreAdapter', 'bulk', collectionName);
    }
  }

  async add<T>(
    collectionName: string,
    data: T,
    schema?: dndevSchema<T>
  ): Promise<{ id: string; data: Record<string, unknown> }> {
    // W7 fix: throw instead of silent no-op when Firestore is unavailable
    if (!(await this.ensureFirestore())) {
      throw wrapCrudError(
        new Error('Firestore not initialized'),
        'FirestoreAdapter',
        'add',
        collectionName
      );
    }
    try {
      // Item 50: schema is optional per ICrudAdapter — skip validation when undefined
      const validated = schema
        ? validateWithSchema(schema, data, 'FirestoreAdapter.add')
        : (data as Record<string, unknown>);
      const colRef = await this.getCollectionRef(collectionName);
      if (!colRef)
        throw wrapCrudError(
          new Error('Firestore not initialized'),
          'FirestoreAdapter',
          'add',
          collectionName
        );

      // Add technical fields client-side (no server functions to generate them)
      // For production data with security, use FunctionsAdapter
      const now = new Date().toISOString();
      const userId = getFirebaseSDK().getCurrentUser()?.uid || 'anonymous';

      const dataWithMetadata = {
        ...validated,
        createdAt: now,
        updatedAt: now,
        createdById: userId,
        updatedById: userId,
      };

      const firestoreData = prepareForFirestore(dataWithMetadata) as any;
      const docRef = await addDoc(colRef, firestoreData);
      const document = { ...dataWithMetadata, id: docRef.id } as Record<
        string,
        unknown
      >;
      return { id: docRef.id, data: document };
    } catch (error) {
      throw wrapCrudError(error, 'FirestoreAdapter', 'add', collectionName);
    }
  }

  async query<T>(
    collectionName: string,
    options: QueryOptions,
    schema?: dndevSchema<unknown>,
    _schemaType?: ListSchemaType
  ): Promise<PaginatedQueryResult<T>> {
    // Item 53: throw on failure like other methods, instead of silently returning empty
    const fs = await this.requireFirestore('query', collectionName);
    const colRef = collection(fs, collectionName);

    try {
      const constraints: QueryConstraint[] = [];
      if (options.where) {
        for (const clause of options.where) {
          constraints.push(
            where(clause.field, clause.operator as WhereFilterOp, clause.value)
          );
        }
      }
      if (options.orderBy) {
        for (const clause of options.orderBy) {
          const direction = (clause.direction || 'asc') as OrderByDirection;
          constraints.push(orderBy(clause.field, direction));
        }
      }

      // Cursor pagination: value of the first orderBy field from the previous page's lastVisible
      const cursor = options.startAfter ?? null;
      if (cursor) {
        // NW9 fix: doc(colRef, cursor) ensures the cursor ID is resolved within
        // collectionName — cross-collection IDs resolve to a different path and
        // Firestore will return an empty snapshot rather than throwing, silently
        // skipping data. Building the ref from colRef (not a root doc()) binds it
        // to the correct collection so mismatched cursors are caught at getDoc time.
        const startAfterDoc = await getDoc(doc(colRef, cursor));
        if (startAfterDoc.exists()) {
          constraints.push(startAfter(startAfterDoc));
        }
      }

      // Request limit+1 to detect hasMore
      const requestLimit = options.limit ? options.limit + 1 : undefined;
      if (requestLimit) {
        constraints.push(limit(requestLimit));
      }

      const q = query(colRef, ...constraints);
      const snapshot = await getDocs(q);

      const results: T[] = [];

      snapshot.forEach((docSnapshot: QueryDocumentSnapshot) => {
        try {
          let data = docSnapshot.data();
          if (!data) {
            return; // Skip documents with no data
          }
          data = transformFirestoreData(data);
          const parsed = schema
            ? validateWithSchema(schema, data, 'FirestoreAdapter.query')
            : (data as Record<string, unknown>);
          // Include document ID in result for key/reference purposes
          results.push({
            ...ensureSpreadable(parsed),
            id: docSnapshot.id,
          } as T);
        } catch (parseError) {
          // Schema validation failed - throw instead of silently skipping
          throw wrapCrudError(
            parseError instanceof Error
              ? parseError
              : new Error(String(parseError)),
            'FirestoreAdapter',
            'query',
            collectionName
          );
        }
      });

      // If we got limit+1 results, we have more pages
      const hasMore = requestLimit
        ? results.length > (options.limit || 0)
        : false;
      // NC4 fix: slice first so lastVisibleId is derived from the kept items only.
      // Previously lastVisibleId was set inside forEach and ended up pointing to
      // the sentinel (limit+1-th) doc — the next page would skip 1 real row.
      const items = hasMore ? results.slice(0, options.limit) : results;
      const lastVisibleId =
        items.length > 0 ? ((items[items.length - 1] as any).id ?? null) : null;

      // Empty results are valid - return empty result, no errors, no logs
      return {
        items,
        hasMore,
        lastVisible: lastVisibleId,
        // FirestoreAdapter doesn't provide total count (would require separate count query)
        total: undefined,
      } as PaginatedQueryResult<T>;
    } catch (error) {
      throw wrapCrudError(error, 'FirestoreAdapter', 'query', collectionName);
    }
  }

  subscribe<T>(
    collectionName: string,
    id: string,
    callback: SubscriptionCallback<T>,
    schema?: dndevSchema<unknown>
  ): Unsubscribe {
    // Synchronous check — subscribe is called after other async operations have initialized Firestore
    if (!this.firestore) return () => {};

    const docRef = doc(this.firestore, collectionName, id);
    return onSnapshot(
      docRef,
      (snapshot: DocumentSnapshot) => {
        try {
          if (!snapshot.exists()) {
            callback(null);
            return;
          }
          let data = snapshot.data();
          data = transformFirestoreData(data);
          const validatedData = schema
            ? validateWithSchema(schema, data, 'FirestoreAdapter.subscribe')
            : (data as Record<string, unknown>);
          // Include document ID in result
          callback({ ...ensureSpreadable(validatedData), id } as T);
        } catch (error) {
          const wrappedError = wrapCrudError(
            error instanceof Error ? error : new Error(String(error)),
            'FirestoreAdapter',
            'subscribe',
            collectionName,
            id
          );
          callback(null, wrappedError);
        }
      },
      (error: FirestoreError) => {
        const wrappedError = wrapCrudError(
          error instanceof Error ? error : new Error(String(error)),
          'FirestoreAdapter',
          'subscribe',
          collectionName,
          id
        );
        callback(null, wrappedError);
      }
    );
  }

  subscribeToCollection<T>(
    collectionName: string,
    options: QueryOptions,
    callback: CollectionSubscriptionCallback<T>,
    schema?: dndevSchema<unknown>
  ): Unsubscribe {
    // Synchronous check — subscribeToCollection is called after other async operations have initialized Firestore
    if (!this.firestore) return () => {};
    const colRef = collection(this.firestore, collectionName);
    if (!colRef) return () => {};

    try {
      const constraints: QueryConstraint[] = [];
      if (options.where) {
        for (const clause of options.where) {
          constraints.push(
            where(clause.field, clause.operator as WhereFilterOp, clause.value)
          );
        }
      }
      if (options.orderBy) {
        for (const clause of options.orderBy) {
          const direction = (clause.direction || 'asc') as OrderByDirection;
          constraints.push(orderBy(clause.field, direction));
        }
      }
      if (options.limit) {
        constraints.push(limit(options.limit));
      }

      const q = query(colRef, ...constraints);
      return onSnapshot(
        q,
        (snapshot: QuerySnapshot) => {
          try {
            const results: T[] = [];
            snapshot.forEach((doc: QueryDocumentSnapshot) => {
              let data = doc.data();
              data = transformFirestoreData(data);
              const parsed = schema
                ? validateWithSchema(
                    schema,
                    data,
                    'FirestoreAdapter.subscribeToCollection'
                  )
                : (data as Record<string, unknown>);
              // Include document ID in result
              results.push({ ...ensureSpreadable(parsed), id: doc.id } as T);
            });
            callback(results);
          } catch (error) {
            const wrappedError = wrapCrudError(
              error instanceof Error ? error : new Error(String(error)),
              'FirestoreAdapter',
              'subscribeToCollection',
              collectionName
            );
            callback([], wrappedError);
          }
        },
        (error: FirestoreError) => {
          const wrappedError = wrapCrudError(
            error instanceof Error ? error : new Error(String(error)),
            'FirestoreAdapter',
            'subscribeToCollection',
            collectionName
          );
          callback([], wrappedError);
        }
      );
    } catch (error) {
      const wrappedError = wrapCrudError(
        error instanceof Error ? error : new Error(String(error)),
        'FirestoreAdapter',
        'subscribeToCollection',
        collectionName
      );
      callback([], wrappedError);
      return () => {};
    }
  }
}
