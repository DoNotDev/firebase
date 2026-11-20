// packages/providers/firebase/src/public/FirestorePublicReader.ts

/**
 * @fileoverview Firestore public reader
 * @description Read-only `ICrudAdapter` over a Firestore instance with no signed-in
 * user (`createPublicServerFirestore`): the Firebase public server reader of the
 * generated sitemap, llms.txt and entity-page `generateStaticParams`. Only `query`
 * reads; every write throws.
 *
 * @version 0.1.0
 * @since 0.3.1
 * @author AMBROISE PARK Consulting
 */

import type { Firestore } from 'firebase/firestore';

import type {
  BulkResult,
  dndevSchema,
  ICrudAdapter,
  PaginatedQueryResult,
  QueryOptions,
} from '@donotdev/core';

import { queryFirestore } from '../client/firestoreQuery';

/**
 * Public (anonymous) Firestore reader: `query` maps `where` / `orderBy` / `limit` like
 * the client `FirestoreAdapter` (same code), and Security Rules return what a
 * signed-out visitor can read. A rule that does not allow the whole query fails it
 * (permission denied): rules are not filters. `get` and every write throw.
 *
 * @example
 * ```ts
 * const CRUD = new FirestorePublicReader(createPublicServerFirestore({ apiKey, projectId }));
 * const { items } = await CRUD.query('products', {
 *   where: [{ field: 'status', operator: 'not-in', value: ['draft', 'deleted'] }],
 *   limit: 1000,
 * });
 * ```
 *
 * @version 0.1.0
 * @since 0.3.1
 */
export class FirestorePublicReader implements ICrudAdapter {
  /**
   * @param firestore - Instance without a signed-in user (`createPublicServerFirestore`)
   */
  constructor(private readonly firestore: Firestore) {}

  /**
   * Query a collection as a signed-out visitor.
   *
   * @param collectionName - Collection to query
   * @param options - Filters, order, cursor and page size
   * @param schema - Optional schema each document is validated against
   * @returns Page of documents with their `id`
   * @throws CRUD error when Security Rules deny the query or the read fails
   * @since 0.3.1
   */
  query<T>(
    collectionName: string,
    options: QueryOptions,
    schema?: dndevSchema<unknown>
  ): Promise<PaginatedQueryResult<T>> {
    return queryFirestore<T>(
      this.firestore,
      collectionName,
      options,
      schema,
      'FirestorePublicReader',
      // Backend only: the Web SDK resolves a denied or unreachable read as an empty
      // offline result, which would publish an empty sitemap instead of failing the build.
      'server'
    );
  }

  /** Not supported: the public reader only lists records (`query`). */
  get<T>(): Promise<T | null> {
    return unsupported('get');
  }

  /** Not supported: the public reader never writes. */
  add(): Promise<{ id: string; data: Record<string, unknown> }> {
    return unsupported('add');
  }

  /** Not supported: the public reader never writes. */
  bulk(): Promise<BulkResult> {
    return unsupported('bulk');
  }

  /** Not supported: the public reader never writes. */
  set(): Promise<Record<string, unknown>> {
    return unsupported('set');
  }

  /** Not supported: the public reader never writes. */
  update(): Promise<Record<string, unknown>> {
    return unsupported('update');
  }

  /** Not supported: the public reader never writes. */
  delete(): Promise<void> {
    return unsupported('delete');
  }
}

/** Rejection of an operation the public reader does not run. */
function unsupported(operation: string): Promise<never> {
  return Promise.reject(
    new Error(
      `[dndev] FirestorePublicReader.${operation}: the public reader only runs query() (anonymous reads of published records).`
    )
  );
}
