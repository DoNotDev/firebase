import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtomicBulkError } from '../../../../core/types/src/crud/errors';
import type { PreparedAtomicBatch } from '../../../../core/types/src/crud/types';

// Native in-memory batch model: proves adapter orchestration, NOT deployed
// Firestore storage or security rules. No external database is contacted.
const native = vi.hoisted(() => ({
  store: new Map<string, Record<string, unknown>>(),
  initialize: vi.fn(), batch: vi.fn(), commit: vi.fn(), doc: vi.fn(),
  actor: vi.fn(), converter: vi.fn(), failPath: '', lostAck: false, stageFailure: false,
}));
vi.mock('@donotdev/core', async () => {
  const errors = await import('../../../../core/types/src/crud/errors');
  return { ...errors, getPlatformEnvVar: () => 'test', wrapCrudError: (error: unknown) => error,
    detectBulkCollisions: () => ({ where: null, collisions: [] }) };
});
vi.mock('../client/sdk', () => ({ getFirebaseSDK: () => ({ getCurrentUser: native.actor }) }));
vi.mock('../client/firestore', async () => {
  const { prepareForFirestore } = await import('../shared/transform');
  native.converter.mockImplementation(prepareForFirestore);
  return {
  getFirebaseFirestore: native.initialize,
  doc: native.doc,
  collection: (_fs: unknown, name: string) => ({ name }),
  prepareForFirestore: native.converter,
  writeBatch: native.batch,
};
});
import { FirestoreAdapter } from '../client/FirestoreAdapter';

beforeEach(() => {
  vi.clearAllMocks();
  native.store.clear();
  native.failPath = '';
  native.lostAck = false;
  native.stageFailure = false;
  native.initialize.mockResolvedValue({});
  native.actor.mockReturnValue({ uid: 'actor' });
  native.doc.mockImplementation((fs, collection, id) => typeof fs?.name === 'string'
    ? { id: 'generated', path: `${fs.name}/generated` }
    : { path: `${collection}/${id}` });
  native.batch.mockImplementation(() => {
    const writes: Array<{ path: string; kind: string; data?: Record<string, unknown> }> = [];
    const stage = (kind: string) => (ref: { path: string }, data?: Record<string, unknown>) => {
      if (native.stageFailure) throw new Error('invalid SDK field path');
      writes.push({ path: ref.path, kind, data });
    };
    native.commit.mockImplementation(async () => {
      const next = new Map(native.store);
      for (const write of writes) {
        if (write.path === native.failPath) throw new Error('permission denied');
        if (write.kind === 'update' && !next.has(write.path)) throw new Error('not found');
        if (write.kind === 'delete') next.delete(write.path);
        else next.set(write.path, write.kind === 'set' ? write.data! : { ...next.get(write.path), ...write.data });
      }
      native.store = next;
      if (native.lostAck) throw new Error('ack lost after commit');
    });
    return { set: stage('set'), update: stage('update'), delete: stage('delete'), commit: native.commit };
  });
});

const linked = (): PreparedAtomicBatch[] => [
  { collection: 'products', inserts: [{ id: 'p1', name: 'product', literal: 'p1' }] },
  { collection: 'offers', inserts: [{ id: 'o1', productId: 'p1', unrelated: 'p1' }] },
];
const capability = () => new FirestoreAdapter().atomicBulkAcross;

function noNativeEffects() {
  expect(native.initialize).not.toHaveBeenCalled();
  expect(native.doc).not.toHaveBeenCalled();
  expect(native.batch).not.toHaveBeenCalled();
  expect(native.commit).not.toHaveBeenCalled();
  expect(native.store.size).toBe(0);
}

describe('Firestore optional atomic capability (native mock orchestration only)', () => {
  it('preflight is side-effect free, does not mutate inputs, and supports repeated calls', async () => {
    const batches = linked();
    const before = structuredClone(batches);
    const atomic = capability();
    await atomic.preflight(batches);
    await atomic.preflight(batches);
    expect(batches).toEqual(before);
    noNativeEffects();
  });

  it.each(['top-level', 'nested', 'null-prototype top-level', 'null-prototype nested'] as const)('rejects own __proto__ at %s before conversion or native work', async (location) => {
    const payload = JSON.parse('{"__proto__":{"atomicPolluted":true}}') as Record<string, unknown>;
    const map = location.startsWith('null-prototype') ? Object.assign(Object.create(null), payload) as Record<string, unknown> : payload;
    const fields = location.endsWith('top-level') ? map : { nested: map };
    expect(Object.hasOwn(map, '__proto__')).toBe(true);
    for (const batch of [
      { collection: 'products', inserts: [Object.defineProperty(Object.create(Object.getPrototypeOf(fields), Object.getOwnPropertyDescriptors(fields)), 'id', { value: 'p', enumerable: true })] },
      { collection: 'products', updates: [{ id: 'p', patch: fields }] },
    ]) {
      await expect(capability().preflight([batch])).rejects.toMatchObject({ outcome: 'not-committed' });
      await expect(capability().execute([batch])).rejects.toMatchObject({ outcome: 'not-committed' });
    }
    expect(native.converter).not.toHaveBeenCalled();
    noNativeEffects();
    expect(Object.hasOwn(Object.prototype, 'atomicPolluted')).toBe(false);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it('commits all collections exactly once, preserving stable IDs and string references', async () => {
    const adapter = new FirestoreAdapter();
    const legacy = vi.spyOn(adapter, 'bulk');
    const batches = linked();
    batches[0]!.inserts!.push({ id: 'p2', name: 'second' });
    await adapter.atomicBulkAcross.preflight(batches);
    const result = await adapter.atomicBulkAcross.execute(batches);
    expect(native.batch).toHaveBeenCalledTimes(1);
    expect(native.commit).toHaveBeenCalledTimes(1);
    expect(legacy).not.toHaveBeenCalled();
    expect(result.results.products).toEqual({ insertedIds: ['p1', 'p2'], updatedIds: [], deletedIds: [], failed: [] });
    expect(result.results.offers?.insertedIds).toEqual(['o1']);
    expect(native.store.get('products/p1')).toMatchObject({ name: 'product', literal: 'p1', createdById: 'actor' });
    expect(native.store.get('products/p1')).not.toHaveProperty('id');
    expect(native.store.get('offers/o1')).toMatchObject({ productId: 'p1', unrelated: 'p1' });
    expect(batches[0]?.inserts?.[0]?.id).toBe('p1');
  });

  it('offer failure leaves neither product nor offer visible in the native model', async () => {
    native.failPath = 'offers/o1';
    await expect(capability().execute(linked())).rejects.toMatchObject({ outcome: 'unknown' });
    expect(native.commit).toHaveBeenCalledTimes(1);
    expect(native.store.has('products/p1')).toBe(false);
    expect(native.store.has('offers/o1')).toBe(false);
  });

  it('lost acknowledgment is unknown, preserves cause, and never replays', async () => {
    native.lostAck = true;
    const error = await capability().execute(linked()).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AtomicBulkError);
    expect(error).toMatchObject({ outcome: 'unknown', cause: { message: 'ack lost after commit' } });
    expect(native.store.has('products/p1')).toBe(true);
    expect(native.store.has('offers/o1')).toBe(true);
    expect(native.commit).toHaveBeenCalledTimes(1);
  });

  it('honors set overwrite, existing updates, and missing delete native semantics', async () => {
    native.store.set('products/p1', { old: true });
    native.store.set('offers/o1', { old: true });
    const result = await capability().execute([
      { collection: 'products', inserts: [{ id: 'p1', name: 'replacement' }], deletes: ['missing'] },
      { collection: 'offers', updates: [{ id: 'o1', patch: { id: 'o1', productId: 'p1' } }] },
    ]);
    expect(native.store.get('products/p1')).not.toHaveProperty('old');
    expect(native.store.get('offers/o1')).toMatchObject({ old: true, productId: 'p1' });
    expect(native.store.get('offers/o1')).not.toHaveProperty('id');
    expect(result.results.products?.deletedIds).toEqual(['missing']);
    expect(result.results.offers?.updatedIds).toEqual(['o1']);
  });

  it('missing update rolls back all collections in the native model', async () => {
    await expect(capability().execute([
      linked()[0]!, { collection: 'offers', updates: [{ id: 'missing', patch: { title: 'x' } }] },
    ])).rejects.toMatchObject({ outcome: 'unknown' });
    expect(native.store.size).toBe(0);
    expect(native.commit).toHaveBeenCalledTimes(1);
  });

  it.each([{ batches: [] }, { batches: [{ collection: 'products' }] }])('empty request is a no-op: $batches', async ({ batches }) => {
    const atomic = capability();
    await atomic.preflight(batches);
    const result = await atomic.execute(batches);
    expect(Object.keys(result.results)).toEqual(batches.map((batch) => batch.collection));
    noNativeEffects();
  });

  const invalid: Array<[string, PreparedAtomicBatch[]]> = [
    ['even collection path', [{ collection: 'products/p1', deletes: ['x'] }]],
    ['empty segment', [{ collection: 'products//offers', deletes: ['x'] }]],
    ['dot segment', [{ collection: '.', deletes: ['x'] }]],
    ['reserved ID', [{ collection: 'products', deletes: ['__bad__'] }]],
    ['slash ID', [{ collection: 'products', deletes: ['a/b'] }]],
    ['empty ID', [{ collection: 'products', inserts: [{ id: '' }] }]],
    ['missing ID', [{ collection: 'products', inserts: [{} as { id: string }] }]],
    ['invalid UTF-8', [{ collection: 'products', deletes: ['\ud800'] }]],
    ['overlong ID', [{ collection: 'products', deletes: ['x'.repeat(1501)] }]],
    ['overlong target path', [{ collection: `${'a'.repeat(1400)}/${'b'.repeat(1400)}/${'c'.repeat(1200)}`, deletes: ['x'.repeat(100)] }]],
    ['duplicate collections', [{ collection: 'products' }, { collection: 'products' }]],
    ['duplicate inserts', [{ collection: 'products', inserts: [{ id: 'x' }, { id: 'x' }] }]],
    ['insert/delete', [{ collection: 'products', inserts: [{ id: 'x' }], deletes: ['x'] }]],
    ['insert/update', [{ collection: 'products', inserts: [{ id: 'x' }], updates: [{ id: 'x', patch: {} }] }]],
    ['update/delete', [{ collection: 'products', updates: [{ id: 'x', patch: {} }], deletes: ['x'] }]],
    ['duplicate deletes', [{ collection: 'products', deletes: ['x', 'x'] }]],
    ['duplicate updates', [{ collection: 'products', updates: [{ id: 'x', patch: {} }, { id: 'x', patch: {} }] }]],
    ['identity change', [{ collection: 'products', updates: [{ id: 'x', patch: { id: 'y' } }] }]],
    ['nested identity change', [{ collection: 'products', updates: [{ id: 'x', patch: { 'id.value': 'y' } }] }]],
    ['overlapping field paths', [{ collection: 'products', updates: [{ id: 'x', patch: { a: {}, 'a-b': 1, 'a.b': 2 } }] }]],
    ['field path support budget', [{ collection: 'products', inserts: [{ id: 'x', value: { ['x'.repeat(800)]: 1 } }] }]],
    ['write limit', [{ collection: 'products', deletes: Array.from({ length: 501 }, (_, i) => `p${i}`) }]],
    ['document support budget', [{ collection: 'products', inserts: [{ id: 'x', text: 'x'.repeat(50000) }] }]],
    ['request support budget', [{ collection: 'products', inserts: Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, text: 'x'.repeat(35000) })) }]],
    ['invalid update field path', [{ collection: 'products', updates: [{ id: 'x', patch: { 'a..b': 1 } }] }]],
    ['unsupported value', [{ collection: 'products', inserts: [{ id: 'x', value: undefined }] }]],
    ['nested arrays', [{ collection: 'products', inserts: [{ id: 'x', value: [[1]] }] }]],
    ['unsupported SDK-like instance', [{ collection: 'products', inserts: [{ id: 'x', value: new Map() }] }]],
  ];
  it.each(invalid)('rejects %s before native batch creation', async (_name, batches) => {
    const atomic = capability();
    await expect(atomic.preflight(batches)).rejects.toMatchObject({ outcome: 'not-committed' });
    noNativeEffects();
    await expect(atomic.execute(batches)).rejects.toMatchObject({ outcome: 'not-committed' });
    noNativeEffects();
  });

  it.each([
    ['non-array batches', 'abc'], ['null batches', null], ['iterable batches', new Set()],
    ['null batch', [null]], ['array batch', [[]]], ['class batch', [new Date()]],
    ['missing collection', [{}]], ['non-string collection', [{ collection: 1 }]],
    ['empty collection', [{ collection: '' }]],
    ...(['inserts', 'updates', 'deletes'] as const).flatMap((bucket) => [
      [`string ${bucket}`, [{ collection: 'products', [bucket]: 'abc' }]],
      [`iterable ${bucket}`, [{ collection: 'products', [bucket]: new Set(['x']) }]],
      [`null ${bucket}`, [{ collection: 'products', [bucket]: null }]],
      [`undefined ${bucket}`, [{ collection: 'products', [bucket]: undefined }]],
    ]),
    ['null insert', [{ collection: 'products', inserts: [null] }]],
    ['array insert', [{ collection: 'products', inserts: [[]] }]],
    ['class insert', [{ collection: 'products', inserts: [new Date()] }]],
    ['null update', [{ collection: 'products', updates: [null] }]],
    ['missing patch', [{ collection: 'products', updates: [{ id: 'x' }] }]],
    ['invalid update ID', [{ collection: 'products', updates: [{ id: 1, patch: {} }] }]],
    ['null patch', [{ collection: 'products', updates: [{ id: 'x', patch: null }] }]],
    ['array patch', [{ collection: 'products', updates: [{ id: 'x', patch: [] }] }]],
    ['extra update key', [{ collection: 'products', updates: [{ id: 'x', patch: {}, extra: true }] }]],
    ['non-string delete', [{ collection: 'products', deletes: [1] }]],
    ['sparse deletes', [{ collection: 'products', deletes: Array(1) }]],
    ['updatedAt metadata conflict', [{ collection: 'products', updates: [{ id: 'x', patch: { 'updatedAt.child': 'x' } }] }]],
    ['updatedById metadata conflict', [{ collection: 'products', updates: [{ id: 'x', patch: { 'updatedById.child': 'x' } }] }]],
  ])('rejects untyped %s without side effects', async (_name, input) => {
    const batches = input as PreparedAtomicBatch[];
    const atomic = capability();
    await expect(atomic.preflight(batches)).rejects.toMatchObject({ outcome: 'not-committed' });
    await expect(atomic.execute(batches)).rejects.toMatchObject({ outcome: 'not-committed' });
    noNativeEffects();
  });

  it('keeps legacy bulk behavior separate from native atomic execution', async () => {
    const adapter = new FirestoreAdapter();
    const result = await adapter.bulk('products', { inserts: [{ name: 'legacy' }] });
    expect(result.insertedIds).toEqual(['generated']);
    expect(native.store.get('products/generated')).toMatchObject({ name: 'legacy', createdById: 'actor' });
    expect(native.commit).toHaveBeenCalledTimes(1);
  });

  it('supports the documented write-count boundary without chunking', async () => {
    await capability().execute([{ collection: 'products', deletes: Array.from({ length: 500 }, (_, i) => `p${i}`) }]);
    expect(native.batch).toHaveBeenCalledTimes(1);
    expect(native.commit).toHaveBeenCalledTimes(1);
  });

  it('supports nested collection paths and identical IDs in distinct collections', async () => {
    await capability().execute([
      { collection: 'shops/s1/products', inserts: [{ id: 'x', date: new Date('2026-01-01'), createdById: 'prepared' }] },
      { collection: 'offers', inserts: [{ id: 'x' }] },
    ]);
    expect(native.store.get('shops/s1/products/x')).toMatchObject({ date: '2026-01-01T00:00:00.000Z', createdById: 'prepared' });
    expect(native.store.has('offers/x')).toBe(true);
  });

  it('staging errors never call commit and are definitively not-committed', async () => {
    native.stageFailure = true;
    await expect(capability().execute(linked())).rejects.toMatchObject({ outcome: 'not-committed' });
    expect(native.commit).not.toHaveBeenCalled();
    expect(native.store.size).toBe(0);
  });

  it('snapshots data before async initialization without rewriting identity or references', async () => {
    let initialize!: (value: object) => void;
    native.initialize.mockReturnValueOnce(new Promise((resolve) => { initialize = resolve; }));
    const batches = linked();
    batches[0]!.inserts![0]!.nested = { value: 'original' };
    const execution = capability().execute(batches);
    batches[0]!.inserts![0]!.id = 'changed';
    (batches[0]!.inserts![0]!.nested as { value: string }).value = 'changed';
    initialize({});
    await execution;
    expect(native.store.get('products/p1')).toMatchObject({ nested: { value: 'original' } });
    expect(native.store.has('products/changed')).toBe(false);
    expect(native.store.get('offers/o1')).toMatchObject({ productId: 'p1' });
  });

  it('budgets the actual authenticated metadata during preflight', async () => {
    native.actor.mockReturnValue({ uid: 'x'.repeat(50000) });
    await expect(capability().preflight(linked())).rejects.toMatchObject({ outcome: 'not-committed' });
    expect(native.batch).not.toHaveBeenCalled();
  });

  it('rejects an identity change between preflight and execution', async () => {
    const batches = linked();
    const atomic = capability();
    const plan = await atomic.preflight(batches);
    native.actor.mockReturnValue({ uid: 'other' });
    await expect(plan!.execute()).rejects.toMatchObject({ outcome: 'not-committed' });
    expect(native.batch).not.toHaveBeenCalled();
  });

  it.each([
    ['signed out to UID anonymous', null, { uid: 'anonymous' }],
    ['UID anonymous to signed out', { uid: 'anonymous' }, null],
  ])('rejects %s before database initialization', async (_name, before, after) => {
    native.actor.mockReturnValue(before);
    const plan = await capability().preflight(linked());
    native.actor.mockReturnValue(after);
    await expect(plan!.execute()).rejects.toMatchObject({ outcome: 'not-committed' });
    noNativeEffects();
  });

  it.each([
    ['signed out to UID anonymous', null, { uid: 'anonymous' }],
    ['UID anonymous to signed out', { uid: 'anonymous' }, null],
  ])('rejects %s across initialization before native staging', async (_name, before, after) => {
    native.actor.mockReturnValue(before);
    let initialize!: (value: object) => void;
    native.initialize.mockReturnValueOnce(new Promise((resolve) => { initialize = resolve; }));
    const plan = await capability().preflight(linked());
    const execution = plan!.execute();
    native.actor.mockReturnValue(after);
    initialize({});
    await expect(execution).rejects.toMatchObject({ outcome: 'not-committed' });
    expect(native.doc).not.toHaveBeenCalled();
    expect(native.batch).not.toHaveBeenCalled();
    expect(native.commit).not.toHaveBeenCalled();
    expect(native.store.size).toBe(0);
  });

  it.each(['anonymous', 'actor'])('accepts same UID %s after user/token refresh', async (uid) => {
    native.actor.mockReturnValue({ uid, token: 'old', claims: { role: 'old' } });
    const plan = await capability().preflight(linked());
    native.actor.mockReturnValue({ uid, token: 'new', claims: { role: 'new' } });
    await plan!.execute();
    expect(native.store.get('products/p1')).toMatchObject({ createdById: uid, updatedById: uid });
    expect(native.batch).toHaveBeenCalledTimes(1);
    expect(native.commit).toHaveBeenCalledTimes(1);
  });

  it('rejects identity changes during staging before commit', async () => {
    const plan = await capability().preflight(linked());
    native.doc.mockImplementation((_, collection, id) => {
      native.actor.mockReturnValue({ uid: 'other' });
      return { path: `${collection}/${id}` };
    });
    await expect(plan!.execute()).rejects.toMatchObject({ outcome: 'not-committed' });
    expect(native.commit).not.toHaveBeenCalled();
  });

  it('retains the timestamp generated at preflight', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const plan = await capability().preflight(linked());
      vi.setSystemTime(new Date('2026-02-01T00:00:00Z'));
      await plan!.execute();
      expect(native.store.get('products/p1')).toMatchObject({
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('isolates simultaneous plans for the same array and distinct actors', async () => {
    const batches = linked();
    const atomic = capability();
    native.actor.mockReturnValue({ uid: 'first' });
    const first = atomic.preflight(batches);
    native.actor.mockReturnValue({ uid: 'second' });
    const second = atomic.preflight(batches);
    const [planA, planB] = await Promise.all([first, second]);
    noNativeEffects();
    await expect(planA!.execute()).rejects.toMatchObject({ outcome: 'not-committed' });
    await planB!.execute();
    expect(native.store.get('products/p1')).toMatchObject({ createdById: 'second' });
    expect(native.commit).toHaveBeenCalledTimes(1);
  });

  it('executes the validated snapshot once despite input mutation and repeated calls', async () => {
    const batches = linked();
    batches[0]!.inserts![0]!.nested = { value: 'original' };
    const plan = await capability().preflight(batches);
    noNativeEffects();
    batches[0]!.inserts![0]!.id = 'changed';
    (batches[0]!.inserts![0]!.nested as { value: string }).value = 'x'.repeat(100000);
    batches[0]!.deletes = ['p1'];
    const [first, second] = await Promise.all([plan!.execute(), plan!.execute()]);
    expect(first).toEqual(second);
    expect(first.results.products?.insertedIds).toEqual(['p1']);
    expect(native.store.get('products/p1')).toMatchObject({ nested: { value: 'original' }, createdById: 'actor' });
    expect(native.store.get('products/p1')?.createdAt).toBe(native.store.get('offers/o1')?.createdAt);
    expect(native.commit).toHaveBeenCalledTimes(1);
    await plan!.execute();
    expect(native.commit).toHaveBeenCalledTimes(1);
  });

  it('never retries a plan after an unknown commit outcome', async () => {
    native.lostAck = true;
    const plan = await capability().preflight(linked());
    await expect(plan!.execute()).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(plan!.execute()).rejects.toMatchObject({ outcome: 'unknown' });
    expect(native.commit).toHaveBeenCalledTimes(1);
  });

  it('execute revalidates a request changed after preflight', async () => {
    const batches = linked();
    const atomic = capability();
    await atomic.preflight(batches);
    batches[0]!.deletes = ['p1'];
    await expect(atomic.execute(batches)).rejects.toMatchObject({ outcome: 'not-committed' });
    expect(native.batch).not.toHaveBeenCalled();
  });
});
