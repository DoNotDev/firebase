// @vitest-environment node

/**
 * @fileoverview Firebase public server reader — unit tests
 * @description `createPublicServerFirestore` (own app, public web config, emulator under
 * the client's flags) and `FirestorePublicReader.query` (the published-records query of
 * the generated sitemap / llms.txt / generateStaticParams mapped to Firestore filters).
 * The Firestore and Firebase app SDKs are mocked: no database is contacted.
 *
 * @version 0.1.0
 * @since 0.3.1
 * @author AMBROISE PARK Consulting
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  apps: [] as Array<{ name: string; options: Record<string, unknown> }>,
  docs: [] as Array<{ id: string; data: Record<string, unknown> }>,
  env: {} as Record<string, string>,
  getDocs: vi.fn(),
  getDocsFromServer: vi.fn(),
  connectFirestoreEmulator: vi.fn(),
}));

vi.mock('firebase/app', () => ({
  getApps: () => sdk.apps,
  initializeApp: vi.fn((options: Record<string, unknown>, name: string) => {
    const app = { name, options };
    sdk.apps.push(app);
    return app;
  }),
}));

vi.mock('firebase/firestore', () => ({
  getFirestore: vi.fn((app: { name: string }) => ({ app })),
  connectFirestoreEmulator: sdk.connectFirestoreEmulator,
  collection: vi.fn((_fs: unknown, name: string) => ({ collection: name })),
  doc: vi.fn(),
  getDoc: vi.fn(),
  where: vi.fn((field: string, operator: string, value: unknown) => ({
    where: [field, operator, value],
  })),
  orderBy: vi.fn((field: string, direction: string) => ({
    orderBy: [field, direction],
  })),
  limit: vi.fn((count: number) => ({ limit: count })),
  startAfter: vi.fn(),
  query: vi.fn((ref: unknown, ...constraints: unknown[]) => ({
    ref,
    constraints,
  })),
  getDocs: sdk.getDocs,
  getDocsFromServer: sdk.getDocsFromServer,
  getDocFromServer: vi.fn(),
}));

vi.mock('@donotdev/core', async (importActual) => ({
  ...(await importActual<typeof import('@donotdev/core')>()),
  getPlatformEnvVar: (name: string) => sdk.env[name],
}));

import { createSchemas } from '@donotdev/core';
import { productEntity } from '@dndev/test-entities';

import { firestoreToISOString } from '../shared/transform';
import {
  createPublicServerFirestore,
  FirestorePublicReader,
} from '../public';

const HIDDEN = ['draft', 'deleted'];
const PUBLIC_QUERY = {
  where: [{ field: 'status', operator: 'not-in' as const, value: HIDDEN }],
  limit: 1000,
};

beforeEach(() => {
  vi.clearAllMocks();
  sdk.apps.length = 0;
  sdk.docs = [];
  sdk.env = {};
  sdk.getDocsFromServer.mockImplementation(async () => ({
    forEach: (visit: (snapshot: unknown) => void) =>
      sdk.docs.forEach(({ id, data }) => visit({ id, data: () => data })),
  }));
});

describe('createPublicServerFirestore', () => {
  it('runs on its own app with the public web config only', () => {
    const firestore = createPublicServerFirestore({
      apiKey: 'web-key',
      projectId: 'shop',
    });
    expect(sdk.apps).toEqual([
      {
        name: 'dndev-public-reader',
        options: { apiKey: 'web-key', projectId: 'shop' },
      },
    ]);
    expect(firestore).toEqual({ app: sdk.apps[0] });
    // Same process, second generated file: same instance, emulator not reconnected
    sdk.env = { NODE_ENV: 'development', USE_FIREBASE_EMULATOR: 'true' };
    createPublicServerFirestore({ apiKey: 'web-key', projectId: 'shop' });
    expect(sdk.apps).toHaveLength(1);
    expect(sdk.connectFirestoreEmulator).not.toHaveBeenCalled();
  });

  it('reads the emulator under the client flags (dev + USE_FIREBASE_EMULATOR)', () => {
    sdk.env = {
      NODE_ENV: 'development',
      USE_FIREBASE_EMULATOR: 'true',
      FIREBASE_FIRESTORE_EMULATOR_PORT: '8181',
    };
    const firestore = createPublicServerFirestore({
      apiKey: 'k',
      projectId: 'p',
    });
    expect(sdk.connectFirestoreEmulator).toHaveBeenCalledWith(
      firestore,
      'localhost',
      8181
    );
  });

  it('reads the project at build (production), even with the emulator flag', () => {
    sdk.env = { NODE_ENV: 'production', USE_FIREBASE_EMULATOR: 'true' };
    createPublicServerFirestore({ apiKey: 'k', projectId: 'p' });
    expect(sdk.connectFirestoreEmulator).not.toHaveBeenCalled();
  });
});

describe('FirestorePublicReader.query', () => {
  const reader = () =>
    new FirestorePublicReader(
      createPublicServerFirestore({ apiKey: 'k', projectId: 'p' })
    );

  it('maps the published-records query to a not-in filter and limit + 1', async () => {
    const at = { seconds: 1_700_000_000, nanoseconds: 0, toDate: () => new Date(1_700_000_000_000) };
    sdk.docs = [
      { id: 'a', data: { slug: 'serum', status: 'available', updatedAt: at } },
      { id: 'b', data: { slug: 'creme', status: 'available' } },
    ];
    const result = await reader().query('products', PUBLIC_QUERY);

    // Backend only: the offline cache would turn a denied read into an empty result.
    expect(sdk.getDocs).not.toHaveBeenCalled();
    expect(sdk.getDocsFromServer).toHaveBeenCalledWith({
      ref: { collection: 'products' },
      constraints: [
        { where: ['status', 'not-in', HIDDEN] },
        { limit: 1001 },
      ],
    });
    expect(result).toEqual({
      items: [
        {
          id: 'a',
          slug: 'serum',
          status: 'available',
          updatedAt: firestoreToISOString(at),
        },
        { id: 'b', slug: 'creme', status: 'available' },
      ],
      hasMore: false,
      lastVisible: 'b',
      total: undefined,
    });
  });

  // The framework's record readers (sitemap, llms.txt, entity pages) pass the entity's
  // read schema (`entityReadSchemas`): documents still come back as stored, with the
  // technical `status` / `updatedAt` (availability, lastmod) and fields outside the entity,
  // never validated (a document the schema rejects must not fail the sitemap)
  it("returns documents as stored with the entity's read schema", async () => {
    const at = { seconds: 1_700_000_000, nanoseconds: 0, toDate: () => new Date(1_700_000_000_000) };
    sdk.docs = [
      {
        id: 'a',
        data: { slug: 'serum', name: 42, status: 'available', updatedAt: at, legacy: 'x' },
      },
    ];
    const result = await reader().query(
      'products',
      PUBLIC_QUERY,
      createSchemas(productEntity).get
    );
    expect(result.items).toEqual([
      {
        id: 'a',
        slug: 'serum',
        name: 42,
        status: 'available',
        updatedAt: firestoreToISOString(at),
        legacy: 'x',
      },
    ]);
  });

  it('reports hasMore from the extra document and drops it', async () => {
    sdk.docs = ['a', 'b', 'c'].map((id) => ({ id, data: { slug: id } }));
    const result = await reader().query('products', { ...PUBLIC_QUERY, limit: 2 });
    expect(result.items.map((item) => (item as { id: string }).id)).toEqual(['a', 'b']);
    expect(result.hasMore).toBe(true);
    expect(result.lastVisible).toBe('b');
  });

  it('fails loud when Security Rules deny the query', async () => {
    sdk.getDocsFromServer.mockRejectedValueOnce(
      Object.assign(new Error('Missing or insufficient permissions.'), {
        code: 'permission-denied',
      })
    );
    await expect(reader().query('products', PUBLIC_QUERY)).rejects.toThrow();
  });

  it('never writes', async () => {
    const crud = reader();
    await expect(crud.set()).rejects.toThrow(
      '[dndev] FirestorePublicReader.set: the public reader only runs query()'
    );
    await expect(crud.add()).rejects.toThrow('FirestorePublicReader.add');
    await expect(crud.update()).rejects.toThrow('FirestorePublicReader.update');
    await expect(crud.delete()).rejects.toThrow('FirestorePublicReader.delete');
    await expect(crud.bulk()).rejects.toThrow('FirestorePublicReader.bulk');
  });
});
