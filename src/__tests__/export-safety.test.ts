/**
 * @fileoverview Export Safety Net — Firebase Provider Package
 * @description Verifies that @donotdev/firebase exports FirebaseAuth and related symbols.
 * Consumer projects and templates import { FirebaseAuth } from '@donotdev/firebase'.
 * If any test fails, consumer projects WILL crash.
 *
 * Tests the client barrel directly to avoid mocking the entire Firebase SDK tree.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('firebase/auth', () => ({
  getAuth: vi.fn(),
  onAuthStateChanged: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  signInWithPopup: vi.fn(),
  signInWithRedirect: vi.fn(),
  GoogleAuthProvider: class {},
  GithubAuthProvider: class {},
  FacebookAuthProvider: class {},
  TwitterAuthProvider: class {},
  OAuthProvider: Object.assign(class {}, { credentialFromError: vi.fn() }),
  EmailAuthProvider: { credential: vi.fn() },
  PhoneAuthProvider: class {},
  createUserWithEmailAndPassword: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  updatePassword: vi.fn(),
  sendEmailVerification: vi.fn(),
  reauthenticateWithCredential: vi.fn(),
  deleteUser: vi.fn(),
  linkWithPopup: vi.fn(),
  linkWithRedirect: vi.fn(),
  signOut: vi.fn(),
  isSignInWithEmailLink: vi.fn(),
  sendSignInLinkToEmail: vi.fn(),
  signInWithEmailLink: vi.fn(),
  signInWithCredential: vi.fn(),
  reauthenticateWithPopup: vi.fn(),
  fetchSignInMethodsForEmail: vi.fn(),
}));

vi.mock('firebase/app', () => ({
  getApps: () => [],
  initializeApp: vi.fn(),
  getApp: vi.fn(),
}));

vi.mock('firebase/app-check', () => ({
  initializeAppCheck: vi.fn(),
  ReCaptchaEnterpriseProvider: vi.fn(),
}));

vi.mock('@donotdev/core', () => ({
  createSingleton: vi.fn((factory: any) => factory),
  safeSessionStorage: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
  handleError: vi.fn((e: any) => e),
  isDev: () => false,
  isClient: () => false,
  ClaimsCache: vi.fn(() => ({ get: vi.fn(), set: vi.fn(), clear: vi.fn() })),
  getAuthPartnerIdByFirebaseId: vi.fn(),
  getRoleFromClaims: vi.fn(),
  getAuthMethod: vi.fn((m: any) => m || 'redirect'),
  AUTH_PARTNER_STATE: {
    IDLE: 'idle',
    LOADING: 'loading',
    ERROR: 'error',
    AUTHENTICATED: 'authenticated',
  },
  EMAIL_VERIFICATION_STATUS: {
    VERIFIED: 'verified',
    PENDING: 'pending',
    ERROR: 'error',
  },
  AUTH_PARTNERS: {},
  SUBSCRIPTION_TIERS: { FREE: 'free' },
  USER_ROLES: { GUEST: 'guest', USER: 'user', ADMIN: 'admin' },
  createDefaultSubscriptionClaims: vi.fn(() => ({})),
  createDefaultUserProfile: vi.fn(() => ({})),
  getPlatformEnvVar: vi.fn(),
  getAuthDomain: vi.fn(),
  AuthHardening: vi.fn(() => ({
    validateOrigin: vi.fn(),
    checkRateLimit: vi.fn(),
  })),
}));

vi.mock('@donotdev/components', () => ({
  toast: vi.fn(),
}));

import { FirebaseAuth, getFirebaseAuth } from '../client/FirebaseAuth';
import * as barrel from '../client/index';

describe('Export Safety Net — @donotdev/firebase (FirebaseAuth)', () => {
  it('exports FirebaseAuth class from client barrel', () => {
    expect(FirebaseAuth).toBeDefined();
    expect(typeof FirebaseAuth).toBe('function');
  });

  it('exports getFirebaseAuth singleton factory from client barrel', () => {
    expect(getFirebaseAuth).toBeDefined();
    expect(typeof getFirebaseAuth).toBe('function');
  });

  it('client barrel re-exports FirebaseAuth', () => {
    expect(barrel.FirebaseAuth).toBeDefined();
    expect(barrel.getFirebaseAuth).toBeDefined();
  });
});
