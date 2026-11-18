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

import type { Firestore } from 'firebase/firestore';

import {
  AtomicBulkError,
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
  BulkAcrossResult,
  PreparedAtomicBatch,
  AtomicBulkExecutionPlan,
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
  type DocumentData,
  type DocumentSnapshot,
  type QuerySnapshot,
  type QueryDocumentSnapshot,
  type CollectionReference,
  type QueryConstraint,
  type Unsubscribe,
  type FirestoreError,
  type OrderByDirection,
} from './firestore';
import { getFirebaseFirestore } from './firestore';
import { getFirebaseSDK } from './sdk';

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
 * A Firestore document as the caller's entity type.
 * why: ICrudAdapter's `T` is caller-asserted; documents are schema-validated (when a schema is given), not checked against `T`.
 */
function asEntity<T>(row: Record<string, unknown>): T {
  return row as T;
}

/**
 * Query order direction for Firestore.
 * why: QueryOrderBy.direction is public `'asc' | 'desc' | string`; Firestore rejects other values at runtime.
 */
function toOrderDirection(direction: string | undefined): OrderByDirection {
  return (direction || 'asc') as OrderByDirection;
}

// Support envelope, not inferred SDK wire sizes. The installed @firebase/firestore
// writeBatch declaration documents 500 writes. The stricter payload/depth/path
// budgets below are adapter policy, deliberately below backend request/document
// limits: https://firebase.google.com/docs/firestore/quotas . Native rules/index
// limits can still reject the whole commit. Never chunk an oversized request.
const ATOMIC_SUPPORT = {
  writes: 500,
  requestBudget: 1024 * 1024,
  documentBudget: 256 * 1024,
  pathBytes: 4096,
  segmentBytes: 1500,
  depth: 16,
} as const;

const atomicEncoder = new TextEncoder();
const atomicDecoder = new TextDecoder('utf-8', { ignoreBOM: true });

function atomicStringBytes(value: string): number {
  const bytes = atomicEncoder.encode(value);
  if (atomicDecoder.decode(bytes) !== value) {
    throw new Error('Atomic Firestore strings must be valid UTF-8');
  }
  return bytes.length;
}

function validateAtomicSegment(segment: string): void {
  if (!segment || segment.includes('/') || segment === '.' || segment === '..' ||
      /^__.*__$/.test(segment) || atomicStringBytes(segment) > ATOMIC_SUPPORT.segmentBytes) {
    throw new Error('Invalid atomic Firestore collection/document path segment');
  }
}

// Deliberately support JSON-like data plus Dates, not transforms, SDK references,
// class instances, undefined, cycles or nested arrays. No string-reference remap.
// Each value/key gets generous encoding overhead; this is a conservative support
// budget, not a claim to reproduce the SDK's protobuf request serialization.
function atomicValueBudget(value: unknown, depth = 0, inArray = false, fieldPathBytes = 0): number {
  if (depth > ATOMIC_SUPPORT.depth) throw new Error('Atomic Firestore nesting limit exceeded');
  if (value === null || typeof value === 'boolean') return 64;
  if (typeof value === 'string') return 64 + atomicStringBytes(value) * 6;
  if (typeof value === 'number' && Number.isFinite(value)) return 64;
  if (value instanceof Date && Number.isFinite(value.getTime())) return 128;
  if (Array.isArray(value)) {
    if (inArray) throw new Error('Atomic Firestore nested arrays are unsupported');
    return 64 + value.reduce((size, item) => size + atomicValueBudget(item, depth + 1, true, fieldPathBytes), 0);
  }
  if (value && typeof value === 'object' &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return 64 + Object.entries(value).reduce((size, [key, item]) => {
      if (!key || /^__.*__$/.test(key) || atomicStringBytes(key) > ATOMIC_SUPPORT.segmentBytes) {
        throw new Error('Unsupported atomic Firestore field name');
      }
      // Budget quoted/escaped field-path segments as well as individual names.
      const nextPathBytes = fieldPathBytes + atomicStringBytes(key) * 2 + 3;
      if (nextPathBytes > ATOMIC_SUPPORT.segmentBytes) {
        throw new Error('Atomic Firestore field path support budget exceeded');
      }
      return size + 64 + atomicStringBytes(key) * 6 + atomicValueBudget(item, depth + 1, false, nextPathBytes);
    }, 0);
  }
  throw new Error('Unsupported atomic Firestore value; use JSON-like data or valid Dates');
}

function isAtomicPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validateAtomicInput(batches: unknown): asserts batches is PreparedAtomicBatch[] {
  if (!Array.isArray(batches)) throw new Error('Atomic Firestore batches must be an array');
  for (const batch of batches) {
    if (!isAtomicPlainObject(batch) || typeof batch.collection !== 'string' || !batch.collection) {
      throw new Error('Atomic Firestore batch must have a collection');
    }
    for (const bucket of ['inserts', 'updates', 'deletes'] as const) {
      if (Object.hasOwn(batch, bucket) && !Array.isArray(batch[bucket])) {
        throw new Error('Atomic Firestore operation buckets must be arrays');
      }
    }
    for (const row of (batch.inserts as unknown[] | undefined) ?? []) {
      if (!isAtomicPlainObject(row) || typeof row.id !== 'string') {
        throw new Error('Atomic Firestore inserts require an object with an ID');
      }
    }
    for (const update of (batch.updates as unknown[] | undefined) ?? []) {
      if (!isAtomicPlainObject(update) || Object.keys(update).length !== 2 ||
          !Object.hasOwn(update, 'id') || !Object.hasOwn(update, 'patch') ||
          typeof update.id !== 'string' || !isAtomicPlainObject(update.patch)) {
        throw new Error('Atomic Firestore updates require exactly an ID and a patch');
      }
    }
    for (const id of (batch.deletes as unknown[] | undefined) ?? []) {
      if (typeof id !== 'string') throw new Error('Atomic Firestore deletes require IDs');
    }
  }
}

type AtomicWrite = {
  collection: string;
  id: string;
  operation: 'set' | 'update' | 'delete';
  data?: DocumentData;
};

/** Validate and snapshot the entire request without opening a native batch. */
function prepareAtomicWrites(batches: PreparedAtomicBatch[], userId = 'anonymous'): {
  writes: AtomicWrite[];
  result: BulkAcrossResult;
} {
  validateAtomicInput(batches);
  const writes: AtomicWrite[] = [];
  const result: BulkAcrossResult = { results: Object.create(null) };
  const collections = new Set<string>();
  const targets = new Set<string>();
  let budget = 0;
  const now = new Date().toISOString();

  for (const batch of batches) {
    const segments = batch.collection.split('/');
    if (segments.length % 2 !== 1 || segments.length > 199 ||
        atomicStringBytes(batch.collection) > ATOMIC_SUPPORT.pathBytes || collections.has(batch.collection)) {
      throw new Error('Atomic Firestore requires unique valid collection paths');
    }
    segments.forEach(validateAtomicSegment);
    collections.add(batch.collection);
    const ids: BulkResult = { insertedIds: [], updatedIds: [], deletedIds: [], failed: [] };
    result.results[batch.collection] = ids;

    const stage = (id: string, operation: AtomicWrite['operation'], data?: Record<string, unknown>) => {
      if (typeof id !== 'string') throw new Error('Atomic Firestore IDs must be explicit strings');
      validateAtomicSegment(id);
      const path = `${batch.collection}/${id}`;
      if (atomicStringBytes(path) > ATOMIC_SUPPORT.pathBytes || targets.has(path)) {
        throw new Error('Atomic Firestore target is duplicated or exceeds path support limit');
      }
      targets.add(path);
      let payload: DocumentData | undefined;
      if (operation !== 'delete') {
        if (!data || Array.isArray(data) ||
            (Object.getPrototypeOf(data) !== Object.prototype && Object.getPrototypeOf(data) !== null)) {
          throw new Error('Atomic Firestore payload must be a plain object');
        }
        if (Object.hasOwn(data, 'id') && data.id !== id) {
          throw new Error('Atomic Firestore payload cannot change technical identity');
        }
        const { id: _technicalId, ...fields } = data;
        // Validate before preparation: the shared converter otherwise flattens SDK
        // transforms/references and silently drops unsupported undefined values.
        atomicValueBudget(fields);
        payload = prepareForFirestore({
          ...(operation === 'set' ? { createdAt: now, createdById: userId } : {}),
          updatedAt: now,
          updatedById: userId,
          ...fields,
        });
        if (operation === 'update') {
          const paths = new Set(Object.keys(payload));
          for (const fieldPath of paths) {
            const parts = fieldPath.split('.');
            if (/[~*/\[\]]/.test(fieldPath) || fieldPath.startsWith('id.') ||
                parts.some((part) => !part || /^__.*__$/.test(part)) ||
                parts.some((_part, index) => index > 0 && paths.has(parts.slice(0, index).join('.')))) {
              throw new Error('Unsupported or overlapping atomic Firestore update field path');
            }
          }
        }
      }
      const size = 1024 + atomicStringBytes(path) * 6 + (payload ? atomicValueBudget(payload) : 0);
      if (size > ATOMIC_SUPPORT.documentBudget) throw new Error('Atomic Firestore document support budget exceeded');
      budget += size;
      writes.push({ collection: batch.collection, id, operation, data: payload });
      if (writes.length > ATOMIC_SUPPORT.writes || budget > ATOMIC_SUPPORT.requestBudget) {
        throw new Error('Atomic Firestore write count or request support budget exceeded');
      }
    };
    for (const row of batch.inserts ?? []) {
      stage(row.id, 'set', row);
      ids.insertedIds.push(row.id);
    }
    for (const update of batch.updates ?? []) {
      stage(update.id, 'update', update.patch);
      ids.updatedIds.push(update.id);
    }
    for (const id of batch.deletes ?? []) {
      stage(id, 'delete');
      ids.deletedIds.push(id);
    }
  }
  return { writes, result };
}

/**
 * Firestore backend adapter
 * Works with any collection dynamically (collection name passed per operation)
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export class FirestoreAdapter implements ICrudAdapter {
  /**
   * Single-database, cross-collection native atomic writes. Preflight is local
   * and side-effect free. Each plan owns its validated snapshot and commits one
   * batch. Insert means native set (may overwrite), update
   * requires an existing document, and deleting a missing document is a no-op.
   *
   * Supports explicit IDs and JSON-like values/valid Dates within ATOMIC_SUPPORT;
   * SDK transforms/references and larger work are rejected, never chunked. String
   * references are retained verbatim. Prepared metadata is preserved; missing
   * timestamp metadata is populated locally. The signed-out state or UID is
   * checked at preflight and execution checkpoints, not frozen continuously;
   * same-UID token refreshes are allowed and session/claims are not snapshotted.
   * Firestore Rules determine permissions at the backend. All commit rejections
   * are conservatively unknown, including lost replies; staging/preflight failures
   * are definitively not-committed. No automatic retry.
   */
  private createAtomicPlan(batches: PreparedAtomicBatch[]): AtomicBulkExecutionPlan {
    let userId: string | null;
    let prepared: ReturnType<typeof prepareAtomicWrites>;
    try {
      userId = getFirebaseSDK().getCurrentUser()?.uid ?? null;
      prepared = prepareAtomicWrites(batches, userId ?? 'anonymous');
    } catch (cause) {
      throw new AtomicBulkError('Firestore atomic preflight rejected', 'not-committed', cause);
    }
    const { writes, result } = prepared;
    let execution: Promise<BulkAcrossResult> | undefined;
    const execute = async (): Promise<BulkAcrossResult> => {
      let commitStarted = false;
      try {
        if ((getFirebaseSDK().getCurrentUser()?.uid ?? null) !== userId) throw new Error('Atomic auth identity changed after preflight');
        if (writes.length === 0) return result;
        const fs = await this.requireFirestore('atomicBulkAcross', '*');
        // Auth may change across the initialization await; never stage under a different actor.
        if ((getFirebaseSDK().getCurrentUser()?.uid ?? null) !== userId) throw new Error('Atomic auth identity changed before staging');
        // Construct every reference before native batch creation. There is never
        // a per-collection bulk call, chunk boundary or generated replacement ID.
        const referenced = writes.map((write) => ({ ...write, ref: doc(fs, write.collection, write.id) }));
        const batch = writeBatch(fs);
        for (const write of referenced) {
          if (write.operation === 'delete') batch.delete(write.ref);
          else if (write.operation === 'set' && write.data) batch.set(write.ref, write.data);
          else if (write.operation === 'update' && write.data) batch.update(write.ref, write.data);
          else throw new Error('Atomic Firestore write is missing its payload');
        }
        if ((getFirebaseSDK().getCurrentUser()?.uid ?? null) !== userId) throw new Error('Atomic auth identity changed before commit');
        commitStarted = true;
        await batch.commit();
        return result;
      } catch (cause) {
        throw new AtomicBulkError('Firestore atomic execution failed', commitStarted ? 'unknown' : 'not-committed', cause);
      }
    };
    return Object.freeze({ execute: () => execution ??= execute() });
  }

  readonly atomicBulkAcross: NonNullable<ICrudAdapter['atomicBulkAcross']> = {
    preflight: async (batches) => this.createAtomicPlan(batches),
    execute: async (batches) => this.createAtomicPlan(batches).execute(),
  };

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
        : data;
      // Include document ID in result
      return asEntity<T>({ ...ensureSpreadable(parsed), id });
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
  ): Promise<Record<string, unknown>> {
    // W7 fix: throw instead of silent no-op when Firestore is unavailable
    const fs = await this.requireFirestore('set', collectionName);
    try {
      const validated = validateWithSchema(
        schema,
        data,
        'FirestoreAdapter.set'
      );
      const docRef = doc(fs, collectionName, id);
      // Technical fields client-side, the same policy as add and the atomic writes.
      const now = new Date().toISOString();
      const userId = getFirebaseSDK().getCurrentUser()?.uid || 'anonymous';
      // why: set<T>'s `T` is unconstrained (ICrudAdapter), so TS cannot prove it is DocumentData
      const firestoreData = prepareForFirestore({
        ...(validated as Record<string, unknown>),
        createdAt: now,
        createdById: userId,
        updatedAt: now,
        updatedById: userId,
      }) as DocumentData;
      await setDoc(docRef, firestoreData);
      // Nothing is set server-side on this path: the payload is the stored document.
      return { ...transformFirestoreData(firestoreData), id };
    } catch (error) {
      throw wrapCrudError(error, 'FirestoreAdapter', 'set', collectionName, id);
    }
  }

  async update<T>(
    collectionName: string,
    id: string,
    data: Partial<T>
  ): Promise<Record<string, unknown>> {
    // W7 fix: throw instead of silent no-op when Firestore is unavailable
    const fs = await this.requireFirestore('update', collectionName);
    try {
      const docRef = doc(fs, collectionName, id);
      // Technical fields client-side, the same policy as add and the atomic writes.
      const firestoreData = prepareForFirestore({
        ...(data as Record<string, unknown>),
        updatedAt: new Date().toISOString(),
        updatedById: getFirebaseSDK().getCurrentUser()?.uid || 'anonymous',
      });
      await updateDoc(docRef, firestoreData);
      // Nothing is set server-side on this path: the patch is what was stored.
      return { ...transformFirestoreData(firestoreData), id };
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
      return { insertedIds: [], updatedIds: [], deletedIds: [], failed: [] };
    }

    // 2. Collision rejection — fail loud before any write.
    const collision = detectBulkCollisions({ inserts, updates, deletes });
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
          : row
      );
      const validatedUpdates = updates.map((u) => ({
        id: u.id,
        patch: schema
          ? validateWithSchema(schema, u.patch, 'FirestoreAdapter.bulk')
          : u.patch,
      }));

      // 5. Client-side metadata injection — identical policy to add/update.
      const now = new Date().toISOString();
      const userId = getFirebaseSDK().getCurrentUser()?.uid || 'anonymous';

      const insertsWithMetadata = validatedInserts.map((row) => ({
        ...row,
        createdAt: now,
        updatedAt: now,
        createdById: userId,
        updatedById: userId,
      }));

      const updatesWithMetadata = validatedUpdates.map((u) => ({
        id: u.id,
        patch: {
          ...u.patch,
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
        batch.set(ref, prepareForFirestore(payload));
        insertedIds.push(ref.id);
      }

      const updatedIds: string[] = [];
      for (const u of updatesWithMetadata) {
        const ref = doc(fs, collectionName, u.id);
        batch.update(ref, prepareForFirestore(u.patch));
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
      // One writeBatch commits all or nothing: no per-row failures
      return { insertedIds, updatedIds, deletedIds, failed: [] };
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
        : data;
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

      const firestoreData = prepareForFirestore(dataWithMetadata);
      const docRef = await addDoc(colRef, firestoreData);
      const document: Record<string, unknown> = {
        ...dataWithMetadata,
        id: docRef.id,
      };
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
            where(clause.field, clause.operator, clause.value)
          );
        }
      }
      if (options.orderBy) {
        for (const clause of options.orderBy) {
          constraints.push(
            orderBy(clause.field, toOrderDirection(clause.direction))
          );
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
      /** Document id of each entry in `results` (same index). */
      const resultIds: string[] = [];

      snapshot.forEach((docSnapshot: QueryDocumentSnapshot) => {
        try {
          let data = docSnapshot.data();
          if (!data) {
            return; // Skip documents with no data
          }
          data = transformFirestoreData(data);
          const parsed = schema
            ? validateWithSchema(schema, data, 'FirestoreAdapter.query')
            : data;
          // Include document ID in result for key/reference purposes
          results.push(
            asEntity<T>({ ...ensureSpreadable(parsed), id: docSnapshot.id })
          );
          resultIds.push(docSnapshot.id);
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
        items.length > 0 ? (resultIds[items.length - 1] ?? null) : null;

      // Empty results are valid - return empty result, no errors, no logs
      return {
        items,
        hasMore,
        lastVisible: lastVisibleId,
        // FirestoreAdapter doesn't provide total count (would require separate count query)
        total: undefined,
      };
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
            : data;
          // Include document ID in result
          callback(asEntity<T>({ ...ensureSpreadable(validatedData), id }));
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
            where(clause.field, clause.operator, clause.value)
          );
        }
      }
      if (options.orderBy) {
        for (const clause of options.orderBy) {
          constraints.push(
            orderBy(clause.field, toOrderDirection(clause.direction))
          );
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
                : data;
              // Include document ID in result
              results.push(
                asEntity<T>({ ...ensureSpreadable(parsed), id: doc.id })
              );
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
