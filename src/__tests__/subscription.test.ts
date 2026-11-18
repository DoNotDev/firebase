import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthActions, AuthState } from '@donotdev/core';
import { ClaimsCache, FEATURE_STATUS, resolveUserSubscription } from '@donotdev/core';

const sdk = vi.hoisted(() => ({
  initialize: vi.fn(), getRedirectResult: vi.fn(), getCurrentUser: vi.fn(),
  getIdTokenResult: vi.fn(), getIdToken: vi.fn(), onAuthStateChanged: vi.fn(),
}));
vi.mock('../client/sdk', () => ({
  getFirebaseSDK: () => sdk,
  GoogleAuthProvider: {}, GithubAuthProvider: {}, FacebookAuthProvider: {},
  TwitterAuthProvider: {}, OAuthProvider: {}, EmailAuthProvider: {},
}));
vi.mock('../client/FirebaseAccountLinking', () => ({ handleOAuthLinking: vi.fn(), clearAccountLinkingState: vi.fn() }));
import { FirebaseAuth } from '../client/FirebaseAuth';

const generic = { tier: 'pro', status: 'active', subscriptionEnd: null, updatedAt: '2026-11-01T00:00:00.000Z', features: ['export'] };
const paid = { ...generic, subscriptionId: 'sub_1', customerId: 'cus_1', cancelAtPeriodEnd: true };
const user = { uid: 'u1', email: 'u@example.com', metadata: {}, providerData: [] };
function harness() {
  const provider = new FirebaseAuth();
  const store = {
    setAuthenticated: vi.fn(), setUnauthenticated: vi.fn(),
    clearAllPartnerStates: vi.fn(), setLoading: vi.fn(), userId: 'u1',
    getCustomClaimsLocal: vi.fn(), setAuthError: vi.fn(), setStatus: vi.fn(),
  };
  provider.setStore(store as unknown as AuthState & AuthActions);
  return { provider, store };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  sdk.getCurrentUser.mockResolvedValue(user);
  sdk.getRedirectResult.mockResolvedValue(null);
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers(); });

describe('Firebase canonical subscription projection', () => {
  it.each([undefined, generic, paid])('refresh applies complete canonical state before resolving: %j', async (subscription) => {
    const { provider, store } = harness();
    const claims = subscription === undefined ? {} : { subscription };
    sdk.getIdTokenResult.mockResolvedValue({ claims, token: 'fresh' });
    expect(await provider.refreshToken()).toBe('fresh');
    expect(store.setAuthenticated.mock.lastCall?.[0]).toMatchObject({ id: 'u1', role: 'user', customClaims: claims });
    expect(store.setAuthenticated.mock.lastCall?.[1]).toEqual(resolveUserSubscription('u1', subscription));
    expect(sdk.getIdTokenResult).toHaveBeenCalledExactlyOnceWith(user, true);
    expect(sdk.getIdToken).not.toHaveBeenCalled();
  });

  it('refresh revoke replaces the entire prior projection, including paid fields and features', async () => {
    const { provider, store } = harness();
    sdk.getIdTokenResult.mockResolvedValueOnce({ claims: { subscription: paid }, token: 'grant' });
    await provider.refreshToken();
    sdk.getIdTokenResult.mockResolvedValueOnce({ claims: { subscription: { ...generic, tier: 'free', status: 'canceled', features: [] } }, token: 'revoke' });
    expect(await provider.refreshToken()).toBe('revoke');
    const refreshed = store.setAuthenticated.mock.lastCall?.[1];
    expect(refreshed).toMatchObject({ tier: 'free', status: 'canceled', isActive: false, features: [] });
    expect(refreshed.subscriptionId).toBeUndefined();
    expect(refreshed.customerId).toBeUndefined();
  });

  it('listener forces fresh initial claims', async () => {
    const { provider, store } = harness();
    sdk.getIdTokenResult.mockResolvedValue({ claims: { subscription: generic } });
    provider.onAuthStateChanged(vi.fn());
    await sdk.onAuthStateChanged.mock.calls[0]?.[0](user);
    expect(sdk.getIdTokenResult).toHaveBeenCalledExactlyOnceWith(user, true);
    expect(store.setAuthenticated.mock.lastCall?.[1]).toEqual(resolveUserSubscription('u1', generic));
  });

  it('settles a rejected initial claims request as an explicit auth error, not perpetual initialization', async () => {
    const { provider, store } = harness();
    const error = new Error('network unavailable');
    sdk.getIdTokenResult.mockRejectedValueOnce(error);
    const callback = vi.fn();
    provider.onAuthStateChanged(callback);
    await expect(sdk.onAuthStateChanged.mock.lastCall?.[0](user)).resolves.toBeUndefined();
    expect(store.setUnauthenticated).toHaveBeenCalled();
    expect(store.setAuthError).toHaveBeenCalledWith(error);
    expect(store.setStatus).toHaveBeenCalledWith(FEATURE_STATUS.ERROR);
    expect(store.setAuthenticated).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith(null);
  });

  it('does not let an obsolete listener failure clear a newly signed-in identity', async () => {
    const { provider, store } = harness();
    let reject!: (error: Error) => void;
    sdk.getIdTokenResult.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    const callback = vi.fn();
    provider.onAuthStateChanged(callback);
    const listener = sdk.onAuthStateChanged.mock.lastCall?.[0];
    const previous = listener(user);
    const nextUser = { ...user, uid: 'u2' };
    sdk.getCurrentUser.mockResolvedValue(nextUser);
    sdk.getIdTokenResult.mockResolvedValue({ claims: {} });
    await listener(nextUser);
    reject(new Error('obsolete failure'));
    await previous;
    expect(store.setAuthenticated.mock.lastCall?.[0].id).toBe('u2');
    expect(store.setUnauthenticated).not.toHaveBeenCalled();
    expect(store.setStatus).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('uses hierarchy and updates complete subscription on tier verification', async () => {
    const { provider, store } = harness();
    await provider.initialize();
    vi.spyOn(provider, 'getCustomClaims').mockResolvedValue({ subscription: paid });
    expect(await provider.hasTier('free')).toBe(true);
    expect(await provider.hasTier('pro')).toBe(true);
    expect(await provider.hasTier('ai')).toBe(false);
    expect(store.setAuthenticated.mock.lastCall?.[1]).toEqual(resolveUserSubscription('u1', paid));
  });

  it.each([generic, paid])('keeps top-level feature access independent of subscription: %j', async (subscription) => {
    const { provider, store } = harness();
    await provider.initialize();
    const claims = { features: ['paid-export'], subscription };
    store.getCustomClaimsLocal.mockReturnValue(claims);
    vi.spyOn(provider, 'getCustomClaims').mockResolvedValue(claims);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    expect(await provider.hasFeature('paid-export')).toBe(true);
    expect(await provider.hasFeature('export')).toBe(false);
  });

  it.each(['sign-out', 'switch', 'sign-out-and-back'] as const)('discards stale refresh after %s without cache/store writes', async (transition) => {
    const { provider, store } = harness();
    const cacheWrite = vi.spyOn(ClaimsCache.prototype, 'setClaims');
    let finish!: (value: { claims: { subscription: typeof paid }; token: string }) => void;
    sdk.getIdTokenResult.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const callback = vi.fn();
    provider.onAuthStateChanged(callback);
    const refresh = provider.refreshToken();
    await vi.waitFor(() => expect(sdk.getIdTokenResult).toHaveBeenCalled());
    if (transition === 'sign-out-and-back') {
      sdk.getCurrentUser.mockResolvedValue(null);
      await sdk.onAuthStateChanged.mock.lastCall?.[0](null);
      sdk.getCurrentUser.mockResolvedValue(user);
    } else {
      sdk.getCurrentUser.mockResolvedValue(transition === 'switch' ? { ...user, uid: 'u2' } : null);
    }
    finish({ claims: { subscription: paid }, token: 'stale' });
    expect(await refresh).toBeNull();
    expect(store.setAuthenticated).not.toHaveBeenCalled();
    expect(cacheWrite).not.toHaveBeenCalled();
  });

  it.each(['switch', 'sign-out'] as const)('does not let delayed listener claims overwrite %s or callback', async (transition) => {
    const { provider, store } = harness();
    let finish!: (value: { claims: { subscription: typeof paid } }) => void;
    sdk.getIdTokenResult.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const callback = vi.fn();
    provider.onAuthStateChanged(callback);
    const listener = sdk.onAuthStateChanged.mock.lastCall?.[0];
    const pending = listener(user);
    const nextUser = transition === 'switch' ? { ...user, uid: 'u2' } : null;
    sdk.getCurrentUser.mockResolvedValue(nextUser);
    sdk.getIdTokenResult.mockResolvedValue({ claims: {} });
    await listener(nextUser);
    finish({ claims: { subscription: paid } });
    await pending;
    expect(store.setAuthenticated).toHaveBeenCalledTimes(transition === 'switch' ? 1 : 0);
    expect(callback).toHaveBeenCalledTimes(1);
    if (nextUser) expect(store.setAuthenticated.mock.lastCall?.[0].id).toBe('u2');
    else expect(callback).toHaveBeenCalledWith(null);
  });

  it.each(['switch', 'sign-out', 'sign-out-and-back'] as const)('discards delayed getCurrentUser after %s', async (transition) => {
    const { provider } = harness();
    let finish!: (value: typeof user) => void;
    sdk.getCurrentUser.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    provider.onAuthStateChanged(vi.fn());
    const pending = provider.getCurrentUser();
    const listener = sdk.onAuthStateChanged.mock.lastCall?.[0];
    const nextUser = transition === 'switch' ? { ...user, uid: 'u2' } : null;
    sdk.getCurrentUser.mockResolvedValue(nextUser);
    sdk.getIdTokenResult.mockResolvedValue({ claims: {} });
    await listener(nextUser);
    if (transition === 'sign-out-and-back') {
      sdk.getCurrentUser.mockResolvedValue(user);
      await listener(user);
    }
    finish(user);
    expect(await pending).toBeNull();
  });

  it.each(['switch', 'sign-out', 'sign-out-and-back'] as const)('discards delayed hasTier claims after %s without stale store writes', async (transition) => {
    const { provider, store } = harness();
    await provider.initialize();
    let finish!: (value: { subscription: typeof paid }) => void;
    const claims = vi.spyOn(provider, 'getCustomClaims').mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    provider.onAuthStateChanged(vi.fn());
    const pending = provider.hasTier('pro');
    await vi.waitFor(() => expect(claims).toHaveBeenCalled());
    const listener = sdk.onAuthStateChanged.mock.lastCall?.[0];
    const nextUser = transition === 'switch' ? { ...user, uid: 'u2' } : null;
    sdk.getCurrentUser.mockResolvedValue(nextUser);
    sdk.getIdTokenResult.mockResolvedValue({ claims: {} });
    await listener(nextUser);
    if (transition === 'sign-out-and-back') {
      sdk.getCurrentUser.mockResolvedValue(user);
      await listener(user);
    }
    store.setAuthenticated.mockClear();
    finish({ subscription: paid });
    expect(await pending).toBe(false);
    expect(store.setAuthenticated).not.toHaveBeenCalled();
  });

  it.each(['switch', 'sign-out'] as const)('rechecks hasTier after applying claims but before returning access on %s', async (transition) => {
    const { provider, store } = harness();
    await provider.initialize();
    vi.spyOn(provider, 'getCustomClaims').mockResolvedValue({ subscription: paid });
    provider.onAuthStateChanged(vi.fn());
    const nextUser = transition === 'switch' ? { ...user, uid: 'u2' } : null;
    store.setAuthenticated.mockImplementationOnce(() => {
      queueMicrotask(() => {
        sdk.getCurrentUser.mockResolvedValue(nextUser);
        sdk.getIdTokenResult.mockResolvedValue({ claims: {} });
        void sdk.onAuthStateChanged.mock.lastCall?.[0](nextUser);
      });
    });
    expect(await provider.hasTier('pro')).toBe(false);
  });

  it('clears stale state when refresh no longer has a signed-in user', async () => {
    const { provider, store } = harness();
    sdk.getCurrentUser.mockResolvedValueOnce(null);
    expect(await provider.refreshToken()).toBeNull();
    expect(store.setUnauthenticated).toHaveBeenCalled();
  });

  it('fails loudly and clears stale access on malformed refreshed claims', async () => {
    const { provider, store } = harness();
    sdk.getIdTokenResult.mockResolvedValue({ claims: { subscription: { tier: 'pro' } }, token: 'bad' });
    await expect(provider.refreshToken()).rejects.toThrow();
    expect(store.setUnauthenticated).toHaveBeenCalled();
    expect(store.setAuthenticated).not.toHaveBeenCalled();
  });
});
