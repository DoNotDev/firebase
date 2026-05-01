// packages/providers/firebase/src/client/sdk.ts

/**
 * @fileoverview Firebase SDK Wrapper - Production Ready
 * @description Type-safe Firebase Auth SDK wrapper with proper auth instance management
 *
 * This wrapper isolates Firebase API changes from the rest of the auth system.
 * When Firebase updates to v13+, only this file needs changes - all business logic
 * in FirebaseAuth and AuthService continues working unchanged.
 *
 * **Architecture Layer:**
 * - SDK: Pure Firebase wrapper with auth instance management (this file)
 * - FirebaseAuth: Firebase-specific business logic
 * - AuthService: High-level orchestration
 * - useAuth: React hook entry point
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 * @license MIT
 *
 * @module @donotdev/firebase/sdk
 */

import { initializeApp, getApps } from 'firebase/app';
import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
  type AppCheck,
} from 'firebase/app-check';
import * as firebaseAuth from 'firebase/auth';
import { GoogleAuthProvider } from 'firebase/auth';

import type { SecurityContext } from '@donotdev/core';
import {
  createSingleton,
  getPlatformEnvVar,
  getAuthDomain,
  handleError,
} from '@donotdev/core';
import { AuthHardening } from '@donotdev/core';

import type { FirebaseConfig } from '../shared/types';
import type { FirebaseApp } from 'firebase/app';
import type {
  Auth,
  User,
  UserCredential,
  UserInfo,
  AuthProvider,
  OAuthProvider,
  RecaptchaVerifier,
  Unsubscribe,
  ActionCodeSettings,
  AuthCredential,
  MultiFactorResolver,
  MultiFactorUser,
  AdditionalUserInfo,
  Persistence,
  OAuthCredential,
  GithubAuthProvider,
  FacebookAuthProvider,
  TwitterAuthProvider,
  EmailAuthProvider,
  PhoneAuthProvider,
} from 'firebase/auth';

// Re-export types for convenience
export type {
  User as FirebaseUser,
  UserInfo,
  OAuthCredential,
  AuthCredential,
} from 'firebase/auth';

// Re-export provider classes
export {
  GoogleAuthProvider,
  GithubAuthProvider,
  FacebookAuthProvider,
  TwitterAuthProvider,
  OAuthProvider,
  EmailAuthProvider,
} from 'firebase/auth';

// =============================================================================
// Module-Level Redirect Result Cache
// =============================================================================
// Fix for React StrictMode double-execution consuming redirect results
// Firebase's getRedirectResult() can only be called once per redirect
// Cache at module level to survive React component re-mounts

/** In-flight redirect result promise (shared across all calls) */
let redirectResultPromise: Promise<UserCredential | null> | null = null;

/** Cached redirect result (undefined = not fetched, null = no redirect, UserCredential = success) */
let redirectResultCache: UserCredential | null | undefined = undefined;

/**
 * Firebase SDK Singleton Wrapper
 *
 * Manages Firebase initialization and provides type-safe wrappers around
 * all Firebase Auth methods. Handles auth instance management internally
 * so consumers never need to pass or manage the auth instance.
 *
 * **Key Responsibilities:**
 * - Initialize Firebase app and auth once
 * - Store auth instance for internal reuse
 * - Handle emulator connections in development
 * - Provide clean, typed interface to Firebase Auth
 * - Isolate Firebase API changes from business logic
 *
 * **NOT Responsible For:**
 * - Error conversion (handled by FirebaseAuth)
 * - Business logic (handled by FirebaseAuth)
 * - State management (handled by AuthService)
 *
 * @class FirebaseSDK
 * @example
 * ```typescript
 * const sdk = getFirebaseSDK();
 * await sdk.initialize();
 * const result = await sdk.signInWithPopup(provider);
 * ```
 */
class FirebaseSDK {
  /** Tracks initialization state */
  private initialized = false;

  /**
   * In-flight initialization promise — guards against concurrent calls.
   * Boolean flag alone is insufficient: two callers can both pass the `if (this.initialized)`
   * check before either sets it to true (TOCTOU race). The promise ensures all concurrent
   * callers wait on the same single initialization.
   */
  private _initPromise: Promise<void> | null = null;

  /** Firebase app instance */
  private app: FirebaseApp | null = null;

  /** Firebase auth instance - managed internally */
  private auth: Auth | null = null;

  /** Firebase App Check instance - auto-enabled if RECAPTCHA_SITE_KEY is set */
  private appCheck: AppCheck | null = null;

  /** Tracks if auth emulator has been connected (can only connect once) */
  private authEmulatorConnected = false;

  /** Optional security context for audit logging + brute-force lockout (SOC2 CC6.1, CC6.2) */
  private security: SecurityContext | null = null;

  /**
   * Default lockout tracker — used when no SecurityContext is injected.
   * When `setSecurity()` is called, delegation is to `security.authHardening` which
   * respects the consumer's configured maxAttempts / lockoutMs.
   * Using AuthHardening (not a raw Map) ensures a single lockout implementation across the stack.
   */
  private readonly defaultHardening = new AuthHardening();

  /**
   * Inject a SecurityContext for audit logging + anomaly detection.
   *
   * @version 0.1.0
   * @since 0.0.1
   */
  setSecurity(security: SecurityContext): void {
    this.security = security;
  }

  /** Active hardening — SecurityContext's when injected, otherwise the default instance. */
  private get _hardening(): AuthHardening {
    return (
      (this.security?.authHardening as AuthHardening | undefined) ??
      this.defaultHardening
    );
  }

  /**
   * Throws if email is currently locked out (SOC2 CC6.2).
   * Uses SecurityContext.authHardening when injected (respects consumer config),
   * otherwise the default AuthHardening instance with standard defaults.
   */
  private _checkLockout(email: string): void {
    this._hardening.checkLockout(email);
  }

  private _recordLockoutFailure(email: string): void {
    const result = this._hardening.recordFailure(email);
    if (result.locked) {
      this.security?.audit({
        type: 'auth.locked',
        metadata: { attempts: result.attempts },
      });
    }
    this.security?.audit({ type: 'auth.login.failure' });
  }

  private _clearLockout(email: string): void {
    this._hardening.recordSuccess(email);
  }

  /**
   * Initialize Firebase app and auth
   *
   * Must be called before any other methods. Safe to call multiple times
   * as initialization only happens once. Loads configuration from environment
   * variables and connects to emulator if in development mode.
   *
   * @returns Promise that resolves when initialization is complete
   * @throws Error if Firebase initialization fails
   *
   * @example
   * ```typescript
   * const sdk = getFirebaseSDK();
   * await sdk.initialize();
   * ```
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    // Promise-based guard: concurrent callers await the same promise instead of
    // each entering the setup block (TOCTOU race with boolean-only guard).
    if (this._initPromise) return this._initPromise;

    this._initPromise = this._doInitialize().finally(() => {
      this._initPromise = null;
    });
    return this._initPromise;
  }

  private async _doInitialize(): Promise<void> {
    try {
      // Validate required config - gracefully degrade if missing
      const apiKey = getPlatformEnvVar('FIREBASE_API_KEY');
      const projectId = getPlatformEnvVar('FIREBASE_PROJECT_ID');

      if (!apiKey || !projectId) {
        // Don't throw - gracefully degrade (auth feature will use DEGRADED_AUTH_API)
        console.warn(
          '[FirebaseSDK] Missing required Firebase configuration. Set VITE_FIREBASE_API_KEY/NEXT_PUBLIC_FIREBASE_API_KEY and VITE_FIREBASE_PROJECT_ID/NEXT_PUBLIC_FIREBASE_PROJECT_ID in your .env file. Running in degraded mode.'
        );
        this.initialized = true; // Mark as initialized to prevent retries
        return;
      }

      // Single-source auth domain from configuration (no derivation)
      const authDomain = getAuthDomain();

      const config: FirebaseConfig = {
        apiKey,
        authDomain,
        projectId,
        storageBucket: getPlatformEnvVar('FIREBASE_STORAGE_BUCKET'),
        messagingSenderId: getPlatformEnvVar('FIREBASE_MESSAGING_SENDER_ID'),
        appId: getPlatformEnvVar('FIREBASE_APP_ID'),
        measurementId: getPlatformEnvVar('FIREBASE_MEASUREMENT_ID'),
      };

      // Initialize Firebase app (once per application)
      if (getApps().length === 0) {
        this.app = initializeApp(config);
      } else {
        this.app = getApps()[0] || null;
      }

      // Get and store auth instance
      this.auth = this.app ? firebaseAuth.getAuth(this.app) : null;

      // Explicitly set persistence for redirect flows
      if (this.auth) {
        try {
          await firebaseAuth.setPersistence(
            this.auth,
            firebaseAuth.browserLocalPersistence
          );
        } catch (persistError) {
          console.warn(
            '[FirebaseSDK] Failed to set persistence:',
            persistError
          );
        }
      }

      // Connect to emulator in development if configured
      // Can only connect once per auth instance - guard against multiple calls
      const isDev = getPlatformEnvVar('NODE_ENV') === 'development';
      const useEmulator = getPlatformEnvVar('USE_FIREBASE_EMULATOR') === 'true';
      if (isDev && useEmulator && this.auth && !this.authEmulatorConnected) {
        const emulatorHost = getPlatformEnvVar('FIREBASE_EMULATOR_HOST');
        const emulatorPort =
          getPlatformEnvVar('FIREBASE_EMULATOR_PORT') || '9099';

        if (emulatorHost) {
          try {
            await firebaseAuth.connectAuthEmulator(
              this.auth,
              `http://${emulatorHost}:${emulatorPort}`,
              {
                disableWarnings: true,
              }
            );
            this.authEmulatorConnected = true;
          } catch (error) {
            // Check if error is "already connected" - that's fine, just mark as connected
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            if (
              errorMessage.includes('already') ||
              errorMessage.includes('emulator-config-failed')
            ) {
              this.authEmulatorConnected = true;
            } else {
              console.warn(
                '[FirebaseSDK] Failed to connect to auth emulator:',
                error
              );
            }
          }
        }
      }

      // App Check initialization deferred until first Firebase operation
      // This prevents reCaptcha scripts from loading on initial page load
      // App Check will be initialized lazily when actually needed

      this.initialized = true;
    } catch (error) {
      // Silent degradation - don't show toast for init failures
      // Toast only for user-initiated actions
      handleError(error, {
        showNotification: false,
        severity: 'warning',
        context: { operation: 'FirebaseSDK.initialize' },
      });
      throw error;
    }
  }

  /**
   * Ensure auth instance is initialized before use
   *
   * Internal method called by all public methods to guarantee auth
   * instance is available. Throws descriptive error if called before
   * initialization.
   *
   * @returns The initialized auth instance
   * @throws Error if auth not initialized
   * @private
   */
  private ensureInitialized(): Auth {
    if (!this.auth) {
      throw new Error(
        'Firebase Auth not initialized. Call initialize() first.'
      );
    }
    return this.auth;
  }

  /**
   * Initialize App Check if reCAPTCHA site key is configured
   * Auto-enables abuse protection for all Firebase resources
   *
   * Lazy initialization - only called when App Check is actually needed
   * This defers reCaptcha script loading until Firebase operations require it
   */
  private async initializeAppCheck(isDev: boolean): Promise<void> {
    if (!this.app) return;
    if (this.appCheck) return; // Already initialized

    const recaptchaSiteKey = getPlatformEnvVar('RECAPTCHA_SITE_KEY');

    if (!recaptchaSiteKey) {
      // No key = no App Check, but don't warn in dev (common setup)
      if (!isDev) {
        console.info(
          '[AppCheck] Not configured. Set VITE_RECAPTCHA_SITE_KEY or NEXT_PUBLIC_RECAPTCHA_SITE_KEY for abuse protection.'
        );
      }
      return;
    }

    try {
      // Enable debug token in development for localhost testing
      // NW6 fix: use a typed augmentation instead of casting window to any
      if (isDev && typeof window !== 'undefined') {
        const debugToken = getPlatformEnvVar('APPCHECK_DEBUG_TOKEN');
        (
          window as Window & { FIREBASE_APPCHECK_DEBUG_TOKEN?: string | true }
        ).FIREBASE_APPCHECK_DEBUG_TOKEN = debugToken || true;
      }

      this.appCheck = initializeAppCheck(this.app, {
        provider: new ReCaptchaEnterpriseProvider(recaptchaSiteKey),
        isTokenAutoRefreshEnabled: true,
      });

      if (isDev) {
        console.log('[AppCheck] Enabled - all Firebase requests are protected');
      }
    } catch (error) {
      // Don't crash app if App Check fails - just log
      console.warn('[AppCheck] Failed to initialize:', error);
    }
  }

  /** Tracks App Check initialization promise to prevent race conditions */
  private appCheckInitPromise: Promise<void> | null = null;

  /**
   * Ensure App Check is initialized (lazy initialization)
   * Called before Firebase operations that benefit from App Check protection
   * Uses promise caching to prevent duplicate initialization
   */
  private async ensureAppCheckInitialized(): Promise<void> {
    if (this.appCheck) return; // Already initialized
    if (!this.initialized) return; // Can't initialize App Check before Firebase SDK

    // If initialization is in progress, wait for it instead of starting another
    if (this.appCheckInitPromise) {
      return this.appCheckInitPromise;
    }

    // Start initialization and cache the promise
    const isDev = getPlatformEnvVar('NODE_ENV') === 'development';
    this.appCheckInitPromise = this.initializeAppCheck(isDev)
      .then(() => {
        // Clear promise cache after successful initialization
        this.appCheckInitPromise = null;
      })
      .catch((error) => {
        // Clear promise cache on error so it can be retried
        this.appCheckInitPromise = null;
        throw error;
      });

    return this.appCheckInitPromise;
  }

  /**
   * Check if App Check is enabled
   */
  isAppCheckEnabled(): boolean {
    return this.appCheck !== null;
  }

  /**
   * Get Firebase app instance
   *
   * Ensures Firebase is initialized and returns the app instance.
   * Safe to call from any consumer - handles initialization order automatically.
   *
   * @returns Promise resolving to Firebase app instance
   * @throws Error if initialization fails
   *
   * @example
   * ```typescript
   * const sdk = getFirebaseSDK();
   * const app = await sdk.getApp();
   * const functions = getFunctions(app, 'europe-west1');
   * ```
   */
  async getApp(): Promise<FirebaseApp> {
    await this.initialize();
    if (!this.app) {
      throw new Error(
        'Firebase app not initialized. This should never happen after initialize().'
      );
    }
    return this.app;
  }

  // ==========================================================================
  // Authentication State Methods
  // ==========================================================================

  /**
   * Subscribe to authentication state changes
   *
   * Registers a callback that fires when auth state changes (sign in,
   * sign out, token refresh, etc.). Returns unsubscribe function.
   *
   * @param nextOrObserver - Callback function receiving user or null
   * @returns Unsubscribe function to stop listening
   *
   * @example
   * ```typescript
   * const unsubscribe = sdk.onAuthStateChanged((user) => {
   *   if (user) {
   *     console.log('Signed in:', user.uid);
   *   } else {
   *     console.log('Signed out');
   *   }
   * });
   * // Later: unsubscribe();
   * ```
   */
  onAuthStateChanged(nextOrObserver: (user: User | null) => void): Unsubscribe {
    const auth = this.ensureInitialized();
    return firebaseAuth.onAuthStateChanged(auth, nextOrObserver);
  }

  /**
   * Register callback before authentication state changes
   *
   * Similar to onAuthStateChanged but fires before state change completes.
   * Useful for performing actions before user data is available.
   *
   * @param nextOrObserver - Callback function receiving user or null
   * @returns Unsubscribe function to stop listening
   */
  beforeAuthStateChanged(
    nextOrObserver: (user: User | null) => void
  ): Unsubscribe {
    const auth = this.ensureInitialized();
    return firebaseAuth.beforeAuthStateChanged(auth, nextOrObserver);
  }

  /**
   * Get current authenticated user
   *
   * Synchronously returns current user or null if signed out.
   * Does not wait for auth state to initialize.
   *
   * @returns Current user or null if not authenticated
   *
   * @example
   * ```typescript
   * const user = sdk.getCurrentUser();
   * if (user) {
   *   console.log('Current user:', user.email);
   * }
   * ```
   */
  getCurrentUser(): User | null {
    const auth = this.ensureInitialized();
    return auth.currentUser;
  }

  // ==========================================================================
  // Redirect Flow Methods
  // ==========================================================================

  /**
   * Get result of a redirect-based sign-in operation
   *
   * Call this after user returns from OAuth redirect. Returns null if
   * no redirect operation was performed or if called before redirect completes.
   *
   * **React StrictMode Safe:**
   * Uses module-level cache to prevent double-execution from consuming the result.
   * Firebase's getRedirectResult() is destructive (one-time read), so we cache
   * it at module scope to survive component re-mounts.
   *
   * @returns Promise resolving to user credential or null
   * @throws Error if redirect operation failed
   *
   * @example
   * ```typescript
   * // After OAuth redirect returns user to your app
   * const result = await sdk.getRedirectResult();
   * if (result?.user) {
   *   console.log('Signed in via redirect:', result.user.email);
   * }
   * ```
   */
  async getRedirectResult(): Promise<UserCredential | null> {
    const auth = this.ensureInitialized();

    // Return cached result if already fetched (prevents StrictMode double-call issue)
    if (redirectResultCache !== undefined) {
      return redirectResultCache;
    }

    // Reuse in-flight promise if already fetching (race condition protection)
    if (redirectResultPromise) {
      return redirectResultPromise;
    }

    // Create new promise and cache it
    redirectResultPromise = firebaseAuth
      .getRedirectResult(auth)
      .then((result) => {
        redirectResultCache = result; // Cache the result (null or UserCredential)
        redirectResultPromise = null; // Clear in-flight promise
        return result;
      })
      .catch((error) => {
        // Silent degradation - don't show toast for redirect result errors during init
        handleError(error, {
          showNotification: false,
          severity: 'warning',
          context: { operation: 'getRedirectResult' },
        });
        redirectResultPromise = null; // Clear in-flight promise on error
        // Don't cache errors - allow retry
        throw error;
      });

    return redirectResultPromise;
  }

  /**
   * Sign in using redirect flow
   *
   * Redirects user to provider's sign-in page. User leaves your app and
   * returns after authentication. Use getRedirectResult() to get result.
   *
   * @param provider - Authentication provider instance
   * @returns Promise resolving when redirect is initiated
   *
   * @example
   * ```typescript
   * const provider = sdk.createGoogleProvider();
   * await sdk.signInWithRedirect(provider);
   * // User redirects to Google, then returns to your app
   * ```
   */
  async signInWithRedirect(provider: AuthProvider): Promise<void> {
    const auth = this.ensureInitialized();
    await this.ensureAppCheckInitialized(); // Lazy initialize App Check on first auth operation
    return firebaseAuth.signInWithRedirect(auth, provider);
  }

  // ==========================================================================
  // Popup Flow Methods
  // ==========================================================================

  /**
   * Sign in using popup flow
   *
   * Opens provider sign-in in popup window. User stays on your app while
   * authenticating in popup. Returns result when popup closes.
   *
   * @param provider - Authentication provider instance
   * @returns Promise resolving to user credential
   * @throws Error if popup blocked or authentication fails
   *
   * @example
   * ```typescript
   * const provider = sdk.createGoogleProvider();
   * const result = await sdk.signInWithPopup(provider);
   * console.log('Signed in:', result.user.email);
   * ```
   */
  async signInWithPopup(provider: AuthProvider): Promise<UserCredential> {
    const auth = this.ensureInitialized();
    await this.ensureAppCheckInitialized(); // Lazy initialize App Check on first auth operation
    return firebaseAuth.signInWithPopup(auth, provider);
  }

  // ==========================================================================
  // Email/Password Methods
  // ==========================================================================

  /**
   * Sign in with email and password
   *
   * Authenticates user with email/password credentials.
   *
   * @param email - User's email address
   * @param password - User's password
   * @returns Promise resolving to user credential
   * @throws Error if credentials are invalid
   *
   * @example
   * ```typescript
   * const result = await sdk.signInWithEmailAndPassword(
   *   'user@example.com',
   *   'password123'
   * );
   * ```
   */
  async signInWithEmailAndPassword(
    email: string,
    password: string
  ): Promise<UserCredential> {
    // SOC2 CC6.2: check brute-force lockout before attempting
    this._checkLockout(email);

    const auth = this.ensureInitialized();
    await this.ensureAppCheckInitialized(); // Lazy initialize App Check on first auth operation
    try {
      const credential = await firebaseAuth.signInWithEmailAndPassword(
        auth,
        email,
        password
      );
      this._clearLockout(email);
      this.security?.audit({
        type: 'auth.login.success',
        userId: credential.user.uid,
        metadata: { email },
      });
      return credential;
    } catch (err) {
      // Item 56: _recordLockoutFailure already audits auth.login.failure with more context
      this._recordLockoutFailure(email);
      throw err;
    }
  }

  /**
   * Create new user account with email and password
   *
   * Creates new user account and signs in automatically.
   *
   * @param email - New user's email address
   * @param password - New user's password
   * @returns Promise resolving to user credential
   * @throws Error if account creation fails
   *
   * @example
   * ```typescript
   * const result = await sdk.createUserWithEmailAndPassword(
   *   'newuser@example.com',
   *   'password123'
   * );
   * ```
   */
  async createUserWithEmailAndPassword(
    email: string,
    password: string
  ): Promise<UserCredential> {
    const auth = this.ensureInitialized();
    await this.ensureAppCheckInitialized(); // Lazy initialize App Check on first auth operation
    return firebaseAuth.createUserWithEmailAndPassword(auth, email, password);
  }

  /**
   * Send password reset email
   *
   * Sends email with link to reset password to specified email address.
   *
   * @param email - Email address to send reset link to
   * @param actionCodeSettings - Optional settings for reset link
   * @returns Promise resolving when email is sent
   *
   * @example
   * ```typescript
   * await sdk.sendPasswordResetEmail('user@example.com');
   * ```
   */
  async sendPasswordResetEmail(
    email: string,
    actionCodeSettings?: ActionCodeSettings
  ): Promise<void> {
    const auth = this.ensureInitialized();
    return firebaseAuth.sendPasswordResetEmail(auth, email, actionCodeSettings);
  }

  /**
   * Confirm password reset with code
   *
   * Completes password reset flow using code from reset email.
   *
   * @param code - Reset code from email
   * @param newPassword - New password to set
   * @returns Promise resolving when password is reset
   *
   * @example
   * ```typescript
   * await sdk.confirmPasswordReset('code-from-email', 'newpassword');
   * ```
   */
  async confirmPasswordReset(code: string, newPassword: string): Promise<void> {
    const auth = this.ensureInitialized();
    return firebaseAuth.confirmPasswordReset(auth, code, newPassword);
  }

  /**
   * Verify password reset code
   *
   * Checks if password reset code is valid and returns associated email.
   *
   * @param code - Reset code from email
   * @returns Promise resolving to email associated with code
   *
   * @example
   * ```typescript
   * const email = await sdk.verifyPasswordResetCode('code-from-email');
   * console.log('Resetting password for:', email);
   * ```
   */
  async verifyPasswordResetCode(code: string): Promise<string> {
    const auth = this.ensureInitialized();
    return firebaseAuth.verifyPasswordResetCode(auth, code);
  }

  // ==========================================================================
  // Email Link Methods
  // ==========================================================================

  /**
   * Sign in with email link
   *
   * Completes email link sign-in flow. Call this with email link from email.
   *
   * @param email - User's email address
   * @param emailLink - Optional email link URL (defaults to current URL)
   * @returns Promise resolving to user credential
   *
   * @example
   * ```typescript
   * const result = await sdk.signInWithEmailLink(
   *   'user@example.com',
   *   window.location.href
   * );
   * ```
   */
  async signInWithEmailLink(
    email: string,
    emailLink?: string
  ): Promise<UserCredential> {
    const auth = this.ensureInitialized();
    await this.ensureAppCheckInitialized(); // Lazy initialize App Check on first auth operation
    return firebaseAuth.signInWithEmailLink(auth, email, emailLink);
  }

  /**
   * Send sign-in link to email
   *
   * Sends email with link that signs user in when clicked.
   *
   * @param email - Email address to send link to
   * @param actionCodeSettings - Settings for sign-in link
   * @returns Promise resolving when email is sent
   *
   * @example
   * ```typescript
   * await sdk.sendSignInLinkToEmail('user@example.com', {
   *   url: 'https://yourapp.com/finishSignIn',
   *   handleCodeInApp: true
   * });
   * ```
   */
  async sendSignInLinkToEmail(
    email: string,
    actionCodeSettings: ActionCodeSettings
  ): Promise<void> {
    const auth = this.ensureInitialized();
    return firebaseAuth.sendSignInLinkToEmail(auth, email, actionCodeSettings);
  }

  /**
   * Check if string is valid email sign-in link
   *
   * Validates whether a URL is a valid email sign-in link.
   *
   * @param emailLink - URL to validate
   * @returns True if valid email sign-in link
   *
   * @example
   * ```typescript
   * if (sdk.isSignInWithEmailLink(window.location.href)) {
   *   // Complete sign-in
   * }
   * ```
   */
  isSignInWithEmailLink(emailLink: string): boolean {
    const auth = this.ensureInitialized();
    return firebaseAuth.isSignInWithEmailLink(auth, emailLink);
  }

  // ==========================================================================
  // Other Sign-In Methods
  // ==========================================================================

  /**
   * Sign in with custom token
   *
   * Signs in using custom token generated by your backend.
   *
   * @param token - Custom auth token
   * @returns Promise resolving to user credential
   *
   * @example
   * ```typescript
   * const token = await getCustomTokenFromBackend();
   * const result = await sdk.signInWithCustomToken(token);
   * ```
   */
  async signInWithCustomToken(token: string): Promise<UserCredential> {
    const auth = this.ensureInitialized();
    return firebaseAuth.signInWithCustomToken(auth, token);
  }

  /**
   * Sign in anonymously
   *
   * Creates temporary anonymous user account.
   *
   * @returns Promise resolving to user credential
   *
   * @example
   * ```typescript
   * const result = await sdk.signInAnonymously();
   * console.log('Anonymous user:', result.user.uid);
   * ```
   */
  async signInAnonymously(): Promise<UserCredential> {
    const auth = this.ensureInitialized();
    return firebaseAuth.signInAnonymously(auth);
  }

  /**
   * Sign in with credential object
   *
   * Signs in using pre-built auth credential.
   *
   * @param credential - Auth credential object
   * @returns Promise resolving to user credential
   *
   * @example
   * ```typescript
   * const credential = GoogleAuthProvider.credential(idToken);
   * const result = await sdk.signInWithCredential(credential);
   * ```
   */
  async signInWithCredential(
    credential: AuthCredential
  ): Promise<UserCredential> {
    const auth = this.ensureInitialized();
    await this.ensureAppCheckInitialized(); // Lazy initialize App Check on first auth operation
    return firebaseAuth.signInWithCredential(auth, credential);
  }

  /**
   * Sign in with phone number
   *
   * Initiates phone number sign-in flow with reCAPTCHA verification.
   *
   * @param phoneNumber - Phone number in E.164 format
   * @param appVerifier - reCAPTCHA verifier instance
   * @returns Promise resolving to confirmation result
   *
   * @example
   * ```typescript
   * const verifier = sdk.createRecaptchaVerifier('recaptcha-container');
   * const result = await sdk.signInWithPhoneNumber('+1234567890', verifier);
   * const code = prompt('Enter verification code:');
   * await result.confirm(code);
   * ```
   */
  async signInWithPhoneNumber(
    phoneNumber: string,
    appVerifier: RecaptchaVerifier
  ): Promise<firebaseAuth.ConfirmationResult> {
    const auth = this.ensureInitialized();
    await this.ensureAppCheckInitialized(); // Lazy initialize App Check on first auth operation
    return firebaseAuth.signInWithPhoneNumber(auth, phoneNumber, appVerifier);
  }

  // ==========================================================================
  // Sign Out
  // ==========================================================================

  /**
   * Sign out current user
   *
   * Signs out currently authenticated user.
   *
   * @returns Promise resolving when sign out completes
   *
   * @example
   * ```typescript
   * await sdk.signOut();
   * console.log('User signed out');
   * ```
   */
  async signOut(): Promise<void> {
    const auth = this.ensureInitialized();
    const currentUser = auth.currentUser;
    await firebaseAuth.signOut(auth);
    this.security?.audit({ type: 'auth.logout', userId: currentUser?.uid });
  }

  // ==========================================================================
  // User Methods (operate on User object, not Auth instance)
  // ==========================================================================

  /**
   * Send email verification to user
   *
   * Sends verification email to user's email address.
   *
   * @param user - User to send verification to
   * @param actionCodeSettings - Optional settings for verification link
   * @returns Promise resolving when email is sent
   *
   * @example
   * ```typescript
   * const user = sdk.getCurrentUser();
   * await sdk.sendEmailVerification(user);
   * ```
   */
  async sendEmailVerification(
    user: User,
    actionCodeSettings?: ActionCodeSettings
  ): Promise<void> {
    return firebaseAuth.sendEmailVerification(user, actionCodeSettings);
  }

  /**
   * Update user's password
   *
   * Changes password for currently signed-in user.
   *
   * @param user - User to update password for
   * @param newPassword - New password
   * @returns Promise resolving when password is updated
   *
   * @example
   * ```typescript
   * const user = sdk.getCurrentUser();
   * await sdk.updatePassword(user, 'newpassword');
   * ```
   */
  async updatePassword(user: User, newPassword: string): Promise<void> {
    return firebaseAuth.updatePassword(user, newPassword);
  }

  /**
   * Update user's email address
   *
   * Changes email address for currently signed-in user.
   *
   * @param user - User to update email for
   * @param newEmail - New email address
   * @returns Promise resolving when email is updated
   */
  async updateEmail(user: User, newEmail: string): Promise<void> {
    return firebaseAuth.updateEmail(user, newEmail);
  }

  /**
   * Update user's profile information
   *
   * Updates display name and/or photo URL.
   *
   * @param user - User to update profile for
   * @param profile - Profile updates (displayName and/or photoURL)
   * @returns Promise resolving when profile is updated
   *
   * @example
   * ```typescript
   * const user = sdk.getCurrentUser();
   * await sdk.updateProfile(user, {
   *   displayName: 'John Doe',
   *   photoURL: 'https://example.com/photo.jpg'
   * });
   * ```
   */
  async updateProfile(
    user: User,
    profile: { displayName?: string | null; photoURL?: string | null }
  ): Promise<void> {
    return firebaseAuth.updateProfile(user, profile);
  }

  /**
   * Reload user data from server
   *
   * Refreshes user's profile data and custom claims.
   *
   * @param user - User to reload
   * @returns Promise resolving when reload completes
   */
  async reload(user: User): Promise<void> {
    return firebaseAuth.reload(user);
  }

  /**
   * Delete user account
   *
   * Permanently deletes user account. Cannot be undone.
   *
   * @param user - User to delete
   * @returns Promise resolving when account is deleted
   */
  async deleteUser(user: User): Promise<void> {
    return firebaseAuth.deleteUser(user);
  }

  /**
   * Get user's ID token
   *
   * Gets current ID token, optionally forcing refresh.
   *
   * @param user - User to get token for
   * @param forceRefresh - Force token refresh even if not expired
   * @returns Promise resolving to ID token string
   *
   * @example
   * ```typescript
   * const user = sdk.getCurrentUser();
   * const token = await sdk.getIdToken(user, true);
   * ```
   */
  async getIdToken(user: User, forceRefresh?: boolean): Promise<string> {
    return firebaseAuth.getIdToken(user, forceRefresh);
  }

  /**
   * Get user's ID token with claims
   *
   * Gets ID token result including custom claims.
   *
   * @param user - User to get token result for
   * @param forceRefresh - Force token refresh
   * @returns Promise resolving to token result with claims
   *
   * @example
   * ```typescript
   * const user = sdk.getCurrentUser();
   * const result = await sdk.getIdTokenResult(user);
   * console.log('Custom claims:', result.claims);
   * ```
   */
  async getIdTokenResult(
    user: User,
    forceRefresh?: boolean
  ): Promise<firebaseAuth.IdTokenResult> {
    return firebaseAuth.getIdTokenResult(user, forceRefresh);
  }

  // ==========================================================================
  // Account Linking Methods
  // ==========================================================================

  /**
   * Link credential to existing account
   *
   * Links additional auth provider to current user's account.
   *
   * @param user - User to link credential to
   * @param credential - Credential to link
   * @returns Promise resolving to updated user credential
   *
   * @example
   * ```typescript
   * const credential = GoogleAuthProvider.credential(idToken);
   * await sdk.linkWithCredential(currentUser, credential);
   * ```
   */
  async linkWithCredential(
    user: User,
    credential: AuthCredential
  ): Promise<UserCredential> {
    return firebaseAuth.linkWithCredential(user, credential);
  }

  /**
   * Link provider using popup
   *
   * Links additional provider to account using popup flow.
   *
   * @param user - User to link provider to
   * @param provider - Provider to link
   * @returns Promise resolving to updated user credential
   */
  async linkWithPopup(
    user: User,
    provider: AuthProvider
  ): Promise<UserCredential> {
    return firebaseAuth.linkWithPopup(user, provider);
  }

  /**
   * Link provider using redirect
   *
   * Links additional provider to account using redirect flow.
   *
   * @param user - User to link provider to
   * @param provider - Provider to link
   * @returns Promise resolving when redirect is initiated
   */
  async linkWithRedirect(user: User, provider: AuthProvider): Promise<void> {
    return firebaseAuth.linkWithRedirect(user, provider);
  }

  /**
   * Link phone number to account
   *
   * Links phone number authentication to existing account.
   *
   * @param user - User to link phone to
   * @param phoneNumber - Phone number in E.164 format
   * @param appVerifier - reCAPTCHA verifier
   * @returns Promise resolving to confirmation result
   */
  async linkWithPhoneNumber(
    user: User,
    phoneNumber: string,
    appVerifier: RecaptchaVerifier
  ): Promise<firebaseAuth.ConfirmationResult> {
    return firebaseAuth.linkWithPhoneNumber(user, phoneNumber, appVerifier);
  }

  /**
   * Unlink provider from account
   *
   * Removes linked provider from user's account.
   *
   * @param user - User to unlink provider from
   * @param providerId - Provider ID to unlink
   * @returns Promise resolving to updated user
   */
  async unlink(user: User, providerId: string): Promise<User> {
    return firebaseAuth.unlink(user, providerId);
  }

  /**
   * Fetch sign-in methods for email
   *
   * Gets list of sign-in methods available for given email address.
   *
   * @param email - Email address to check
   * @returns Promise resolving to array of provider IDs
   *
   * @example
   * ```typescript
   * const methods = await sdk.fetchSignInMethodsForEmail('user@example.com');
   * console.log('Available methods:', methods); // ['google.com', 'password']
   * ```
   */
  async fetchSignInMethodsForEmail(email: string): Promise<string[]> {
    const auth = this.ensureInitialized();
    return firebaseAuth.fetchSignInMethodsForEmail(auth, email);
  }

  // ==========================================================================
  // Re-authentication Methods
  // ==========================================================================

  /**
   * Re-authenticate with credential
   *
   * Re-authenticates user before sensitive operations.
   *
   * @param user - User to re-authenticate
   * @param credential - Credential to re-authenticate with
   * @returns Promise resolving to user credential
   */
  async reauthenticateWithCredential(
    user: User,
    credential: AuthCredential
  ): Promise<UserCredential> {
    return firebaseAuth.reauthenticateWithCredential(user, credential);
  }

  /**
   * Re-authenticate using popup
   *
   * Re-authenticates user using popup flow.
   *
   * @param user - User to re-authenticate
   * @param provider - Provider to use
   * @returns Promise resolving to user credential
   */
  async reauthenticateWithPopup(
    user: User,
    provider: AuthProvider
  ): Promise<UserCredential> {
    return firebaseAuth.reauthenticateWithPopup(user, provider);
  }

  /**
   * Re-authenticate using redirect
   *
   * Re-authenticates user using redirect flow.
   *
   * @param user - User to re-authenticate
   * @param provider - Provider to use
   * @returns Promise resolving when redirect is initiated
   */
  async reauthenticateWithRedirect(
    user: User,
    provider: AuthProvider
  ): Promise<void> {
    return firebaseAuth.reauthenticateWithRedirect(user, provider);
  }

  // ==========================================================================
  // Provider Creation Methods
  // ==========================================================================

  /**
   * Create Google auth provider
   *
   * @returns New Google provider instance
   *
   * @example
   * ```typescript
   * const provider = sdk.createGoogleProvider();
   * provider.addScope('https://www.googleapis.com/auth/drive.readonly');
   * ```
   */
  createGoogleProvider(): GoogleAuthProvider {
    return new firebaseAuth.GoogleAuthProvider();
  }

  /**
   * Create GitHub auth provider
   *
   * @returns New GitHub provider instance
   */
  createGithubProvider(): GithubAuthProvider {
    return new firebaseAuth.GithubAuthProvider();
  }

  /**
   * Create Facebook auth provider
   *
   * @returns New Facebook provider instance
   */
  createFacebookProvider(): FacebookAuthProvider {
    return new firebaseAuth.FacebookAuthProvider();
  }

  /**
   * Create Twitter auth provider
   *
   * @returns New Twitter provider instance
   */
  createTwitterProvider(): TwitterAuthProvider {
    return new firebaseAuth.TwitterAuthProvider();
  }

  /**
   * Create Microsoft auth provider
   *
   * @returns New Microsoft OAuth provider instance
   */
  createMicrosoftProvider(): OAuthProvider {
    return new firebaseAuth.OAuthProvider('microsoft.com');
  }

  /**
   * Create Apple auth provider
   *
   * @returns New Apple OAuth provider instance
   */
  createAppleProvider(): OAuthProvider {
    return new firebaseAuth.OAuthProvider('apple.com');
  }

  /**
   * Create generic OAuth provider
   *
   * Creates provider for any OAuth-compatible service.
   *
   * @param providerId - Provider ID (e.g., 'discord.com')
   * @returns New OAuth provider instance
   *
   * @example
   * ```typescript
   * const provider = sdk.createOAuthProvider('discord.com');
   * provider.addScope('identify');
   * ```
   */
  createOAuthProvider(providerId: string): OAuthProvider {
    return new firebaseAuth.OAuthProvider(providerId);
  }

  /**
   * Create phone auth provider
   *
   * @returns New phone auth provider instance
   */
  createPhoneAuthProvider(): PhoneAuthProvider {
    const auth = this.ensureInitialized();
    return new firebaseAuth.PhoneAuthProvider(auth);
  }

  /**
   * Create email auth provider
   *
   * @returns New email auth provider instance
   */
  createEmailAuthProvider(): typeof EmailAuthProvider {
    return firebaseAuth.EmailAuthProvider;
  }

  /**
   * Create reCAPTCHA verifier
   *
   * Creates verifier for phone authentication.
   *
   * @param container - Container element ID or element reference
   * @param parameters - Optional reCAPTCHA parameters
   * @returns New reCAPTCHA verifier instance
   *
   * @example
   * ```typescript
   * const verifier = sdk.createRecaptchaVerifier('recaptcha-container', {
   *   size: 'invisible'
   * });
   * ```
   */
  createRecaptchaVerifier(
    container: string | HTMLElement,
    parameters?: firebaseAuth.RecaptchaParameters
  ): RecaptchaVerifier {
    const auth = this.ensureInitialized();
    return new firebaseAuth.RecaptchaVerifier(auth, container, parameters);
  }

  // ==========================================================================
  // Multi-Factor Authentication
  // ==========================================================================

  /**
   * Get multi-factor interface for user
   *
   * @param user - User to get multi-factor for
   * @returns Multi-factor user interface
   */
  multiFactor(user: User): MultiFactorUser {
    return firebaseAuth.multiFactor(user);
  }

  /**
   * Get multi-factor resolver from error
   *
   * Creates resolver for handling multi-factor authentication errors.
   *
   * @param error - Multi-factor error from sign-in attempt
   * @returns Multi-factor resolver instance
   */
  getMultiFactorResolver(
    error: firebaseAuth.MultiFactorError
  ): MultiFactorResolver {
    const auth = this.ensureInitialized();
    return firebaseAuth.getMultiFactorResolver(auth, error);
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Get additional user info from credential
   *
   * Extracts additional user information from sign-in result.
   *
   * @param result - User credential from sign-in
   * @returns Additional user info or null
   *
   * @example
   * ```typescript
   * const result = await sdk.signInWithPopup(provider);
   * const info = sdk.getAdditionalUserInfo(result);
   * if (info?.isNewUser) {
   *   console.log('Welcome new user!');
   * }
   * ```
   */
  getAdditionalUserInfo(result: UserCredential): AdditionalUserInfo | null {
    return firebaseAuth.getAdditionalUserInfo(result);
  }

  /**
   * Set authentication state persistence
   *
   * Controls how auth state persists between sessions.
   *
   * @param persistence - Persistence type (local, session, or none)
   * @returns Promise resolving when persistence is set
   *
   * @example
   * ```typescript
   * // Persist until browser closes
   * await sdk.setPersistence(firebaseAuth.browserSessionPersistence);
   * ```
   */
  async setPersistence(persistence: Persistence): Promise<void> {
    const auth = this.ensureInitialized();
    return firebaseAuth.setPersistence(auth, persistence);
  }

  /**
   * Set session persistence by boolean (remember me).
   * true → browserLocalPersistence (survives browser close)
   * false → browserSessionPersistence (tab-only)
   */
  async setRememberMe(remember: boolean): Promise<void> {
    return this.setPersistence(
      remember
        ? firebaseAuth.browserLocalPersistence
        : firebaseAuth.browserSessionPersistence
    );
  }

  /**
   * Set auth language to device default
   *
   * Sets Firebase Auth UI language to user's device language.
   */
  useDeviceLanguage(): void {
    const auth = this.ensureInitialized();
    return firebaseAuth.useDeviceLanguage(auth);
  }

  /**
   * Check action code validity
   *
   * Validates action code from email (password reset, email verification, etc.).
   *
   * @param code - Action code from email
   * @returns Promise resolving to action code info
   */
  async checkActionCode(code: string): Promise<firebaseAuth.ActionCodeInfo> {
    const auth = this.ensureInitialized();
    return firebaseAuth.checkActionCode(auth, code);
  }

  /**
   * Apply action code
   *
   * Applies action code from email (email verification, password reset, etc.).
   *
   * @param code - Action code from email
   * @returns Promise resolving when code is applied
   */
  async applyActionCode(code: string): Promise<void> {
    const auth = this.ensureInitialized();
    return firebaseAuth.applyActionCode(auth, code);
  }

  // ==========================================================================
  // HIGH-LEVEL METHODS (Simple API for consumers)
  // ==========================================================================

  /**
   * Sign in with Google using popup
   *
   * @returns Promise resolving to user credential
   */
  async signInWithGoogle(): Promise<UserCredential> {
    const provider = this.createGoogleProvider();
    return await this.signInWithPopup(provider);
  }

  /**
   * Sign in with Google using redirect
   *
   * @returns Promise resolving when redirect is initiated
   */
  async signInWithGoogleRedirect(): Promise<void> {
    const provider = this.createGoogleProvider();
    return await this.signInWithRedirect(provider);
  }

  /**
   * Sign in with GitHub using popup
   *
   * @returns Promise resolving to user credential
   */
  async signInWithGitHub(): Promise<UserCredential> {
    const provider = this.createGithubProvider();
    return await this.signInWithPopup(provider);
  }

  /**
   * Sign in with GitHub using redirect
   *
   * @returns Promise resolving when redirect is initiated
   */
  async signInWithGitHubRedirect(): Promise<void> {
    const provider = this.createGithubProvider();
    return await this.signInWithRedirect(provider);
  }

  /**
   * Sign in with Facebook using popup
   *
   * @returns Promise resolving to user credential
   */
  async signInWithFacebook(): Promise<UserCredential> {
    const provider = this.createFacebookProvider();
    return await this.signInWithPopup(provider);
  }

  /**
   * Sign in with Facebook using redirect
   *
   * @returns Promise resolving when redirect is initiated
   */
  async signInWithFacebookRedirect(): Promise<void> {
    const provider = this.createFacebookProvider();
    return await this.signInWithRedirect(provider);
  }

  /**
   * Sign in with Twitter using popup
   *
   * @returns Promise resolving to user credential
   */
  async signInWithTwitter(): Promise<UserCredential> {
    const provider = this.createTwitterProvider();
    return await this.signInWithPopup(provider);
  }

  /**
   * Sign in with Twitter using redirect
   *
   * @returns Promise resolving when redirect is initiated
   */
  async signInWithTwitterRedirect(): Promise<void> {
    const provider = this.createTwitterProvider();
    return await this.signInWithRedirect(provider);
  }

  /**
   * Sign in with Microsoft using popup
   *
   * @returns Promise resolving to user credential
   */
  async signInWithMicrosoft(): Promise<UserCredential> {
    const provider = this.createMicrosoftProvider();
    return await this.signInWithPopup(provider);
  }

  /**
   * Sign in with Microsoft using redirect
   *
   * @returns Promise resolving when redirect is initiated
   */
  async signInWithMicrosoftRedirect(): Promise<void> {
    const provider = this.createMicrosoftProvider();
    return await this.signInWithRedirect(provider);
  }

  /**
   * Sign in with Apple using popup
   *
   * @returns Promise resolving to user credential
   */
  async signInWithApple(): Promise<UserCredential> {
    const provider = this.createAppleProvider();
    return await this.signInWithPopup(provider);
  }

  /**
   * Sign in with Apple using redirect
   *
   * @returns Promise resolving when redirect is initiated
   */
  async signInWithAppleRedirect(): Promise<void> {
    const provider = this.createAppleProvider();
    return await this.signInWithRedirect(provider);
  }

  /**
   * Sign in with Google credential (for Google One Tap)
   *
   * @param credential - Google ID token
   * @returns Promise resolving to user credential
   */
  async signInWithGoogleCredential(
    credential: string
  ): Promise<UserCredential> {
    // Item 57: removed unused GoogleAuthProvider() instantiation — only the static method is needed
    const credentialResult = GoogleAuthProvider.credential(credential);
    return await this.signInWithCredential(credentialResult);
  }

  /**
   * Sign in with email and password (high-level)
   *
   * @param email - User's email address
   * @param password - User's password
   * @returns Promise resolving to user credential
   */
  async signInWithEmail(
    email: string,
    password: string
  ): Promise<UserCredential> {
    return await this.signInWithEmailAndPassword(email, password);
  }

  /**
   * Create user with email and password (high-level)
   *
   * @param email - User's email address
   * @param password - User's password
   * @returns Promise resolving to user credential
   */
  async createUserWithEmail(
    email: string,
    password: string
  ): Promise<UserCredential> {
    return await this.createUserWithEmailAndPassword(email, password);
  }

  /**
   * Link Google account to current user
   *
   * @param user - Current user
   * @returns Promise resolving to updated user credential
   */
  async linkWithGoogle(user: User): Promise<UserCredential> {
    const provider = this.createGoogleProvider();
    return await this.linkWithPopup(user, provider);
  }

  /**
   * Link GitHub account to current user
   *
   * @param user - Current user
   * @returns Promise resolving to updated user credential
   */
  async linkWithGitHub(user: User): Promise<UserCredential> {
    const provider = this.createGithubProvider();
    return await this.linkWithPopup(user, provider);
  }

  /**
   * Link Facebook account to current user
   *
   * @param user - Current user
   * @returns Promise resolving to updated user credential
   */
  async linkWithFacebook(user: User): Promise<UserCredential> {
    const provider = this.createFacebookProvider();
    return await this.linkWithPopup(user, provider);
  }

  /**
   * Link Twitter account to current user
   *
   * @param user - Current user
   * @returns Promise resolving to updated user credential
   */
  async linkWithTwitter(user: User): Promise<UserCredential> {
    const provider = this.createTwitterProvider();
    return await this.linkWithPopup(user, provider);
  }

  /**
   * Link Microsoft account to current user
   *
   * @param user - Current user
   * @returns Promise resolving to updated user credential
   */
  async linkWithMicrosoft(user: User): Promise<UserCredential> {
    const provider = this.createMicrosoftProvider();
    return await this.linkWithPopup(user, provider);
  }

  /**
   * Link Apple account to current user
   *
   * @param user - Current user
   * @returns Promise resolving to updated user credential
   */
  async linkWithApple(user: User): Promise<UserCredential> {
    const provider = this.createAppleProvider();
    return await this.linkWithPopup(user, provider);
  }

  /**
   * Reset SDK state (HMR support)
   *
   * Called during hot module replacement to reset singleton state.
   * Internal method for development only.
   *
   * @internal
   */
  reset(): void {
    this.initialized = false;
    this._initPromise = null;
    this.auth = null;
    this.app = null;
    this.appCheck = null;
  }
}

/**
 * Get singleton instance of Firebase SDK wrapper
 *
 * Always returns same instance. Safe to call multiple times.
 *
 * @returns Singleton FirebaseSDK instance
 *
 * @example
 * ```typescript
 * const sdk = getFirebaseSDK();
 * await sdk.initialize();
 * const user = sdk.getCurrentUser();
 * ```
 */
export const getFirebaseSDK = createSingleton(() => new FirebaseSDK());

// ❌ REMOVED: HMR disposal block
// Zustand handles HMR correctly, no manual disposal needed
