// packages/providers/firebase/src/client/firestoreQuery.ts

/**
 * @fileoverview Firestore collection query
 * @description `ICrudAdapter.query` on a given Firestore instance: where / orderBy /
 * startAfter / limit mapping and document transform. Shared by the client
 * `FirestoreAdapter` and the public server reader (`@donotdev/firebase/public`), so it
 * imports the Firestore SDK directly, never the auth SDK or the app's Firebase bootstrap.
 *
 * @version 0.1.0
 * @since 0.3.1
 * @author AMBROISE PARK Consulting
 */

import {
  collection,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  getDocsFromServer,
  limit,
  orderBy,
  query,
  startAfter,
  where,
} from 'firebase/firestore';
import type {
  Firestore,
  OrderByDirection,
  QueryConstraint,
  QueryDocumentSnapshot,
} from 'firebase/firestore';

import {
  ensureSpreadable,
  validateWithSchema,
  wrapCrudError,
} from '@donotdev/core';
import type {
  dndevSchema,
  PaginatedQueryResult,
  QueryOptions,
} from '@donotdev/core';

import { transformFirestoreData } from '../shared/transform';

/**
 * A Firestore document as the caller's entity type.
 * why: ICrudAdapter's `T` is caller-asserted; documents are schema-validated (when a schema is given), not checked against `T`.
 *
 * @since 0.3.1
 */
export function asEntity<T>(row: Record<string, unknown>): T {
  return row as T;
}

/**
 * Query order direction for Firestore.
 * why: QueryOrderBy.direction is public `'asc' | 'desc' | string`; Firestore rejects other values at runtime.
 *
 * @since 0.3.1
 */
export function toOrderDirection(
  direction: string | undefined
): OrderByDirection {
  return (direction || 'asc') as OrderByDirection;
}

/**
 * Query a collection: `where` clauses as Firestore filters (operators passed through,
 * e.g. `not-in`), `orderBy`, `startAfter` (document id cursor), `limit` (one extra
 * document requested to detect `hasMore`). Each document is transformed
 * (`transformFirestoreData`), validated against `schema` when given, and returned with
 * its `id`.
 *
 * @param firestore - Firestore instance to read
 * @param collectionName - Collection to query
 * @param options - Filters, order, cursor and page size
 * @param schema - Optional schema each document is validated against
 * @param adapterName - Adapter named in wrapped errors
 * @param source - `'default'`: the SDK's normal read (offline cache allowed, the client).
 *   `'server'`: the backend only, so a denied or unreachable read throws instead of
 *   resolving empty from the offline cache (the build-time public reader).
 * @returns Page of documents; `total` is not computed
 * @throws CRUD error (wrapCrudError) when the read or a document's validation fails
 *
 * @version 0.1.0
 * @since 0.3.1
 */
export async function queryFirestore<T>(
  firestore: Firestore,
  collectionName: string,
  options: QueryOptions,
  schema: dndevSchema<unknown> | undefined,
  adapterName: string,
  source: 'default' | 'server' = 'default'
): Promise<PaginatedQueryResult<T>> {
  const colRef = collection(firestore, collectionName);

  try {
    const constraints: QueryConstraint[] = [];
    if (options.where) {
      for (const clause of options.where) {
        constraints.push(where(clause.field, clause.operator, clause.value));
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
      const cursorRef = doc(colRef, cursor);
      const startAfterDoc = await (source === 'server'
        ? getDocFromServer(cursorRef)
        : getDoc(cursorRef));
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
    const snapshot = await (source === 'server'
      ? getDocsFromServer(q)
      : getDocs(q));

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
          ? validateWithSchema(schema, data, `${adapterName}.query`)
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
          adapterName,
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
      // No total count (would require a separate count query)
      total: undefined,
    };
  } catch (error) {
    throw wrapCrudError(error, adapterName, 'query', collectionName);
  }
}
