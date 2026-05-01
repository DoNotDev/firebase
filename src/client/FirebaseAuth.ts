// packages/providers/firebase/src/client/FirebaseAuth.ts

/**
 * @fileoverview FirebaseAuth - Complete Firebase Authentication Orchestrator
 * @description Complete business logic layer that handles Firebase operations and smart recovery, store updates via domain methods, partner state management, and security checks (roles, tiers, features). Supports smart recovery with auto-signup and intelligent account linking.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { toast } from '@donotdev/components';
import type {
  AuthUser,
  AuthResult,
  AuthPartnerId,
  AuthMethod,
  AuthProvider,
  SubscriptionClaims,
  UserProfile,
  UserSubscription,
  AppConfig,
  AuthState,
  AuthActions,
  SecurityContext,
  SignUpMetadata,
} from '@donotdev/core';
import {
  createSingleton,
  safeSessionStorage,
  handleError,
  isDev,
  isClient,
  ClaimsCache,
  getAuthPartnerIdByFirebaseId,
  getRoleFromClaims,
  getAuthMethod,
  AUTH_PARTNER_STATE as PARTNER_STATE,
  EMAIL_VERIFICATION_STATUS,
  AUTH_PARTNERS,
  SUBSCRIPTION_TIERS,
  USER_ROLES,
  createDefaultSubscriptionClaims,
  createDefaultUserProfile,
  hasRoleAccess,
} from '@donotdev/core';

import {
  handleOAuthLinking,
  clearAccountLinkingState,
  type AccountLinkingDependencies,
} from './FirebaseAccountLinking';
import {
  handleSmartRecovery,
  type SmartRecoveryDependencies,
} from './FirebaseSmartRecovery';
import {
  getFirebaseSDK,
  GoogleAuthProvider,
  GithubAuthProvider,
  FacebookAuthProvider,
  TwitterAuthProvider,
  OAuthProvider,
  EmailAuthProvider,
} from './sdk';

import type { FirebaseUser, AuthCredential, UserInfo } from './sdk';

/**
 * Dual fallback helper for extracting existing provider
 *
 * Tries to extract the provider from the error object first (fast),
 * then falls back to fetching sign-in methods (reliable).
 *
 * @param sdk - Firebase SDK instance
 * @param error - Firebase error object
 * @param email - User email address
 * @returns Provider ID or null if not found
 */
async function getExistingProvider(
  sdk: ReturnType<typeof getFirebaseSDK>,
  error: any,
  email: string
): Promise<AuthPartnerId | null> {
  // Extract existing provider from error object (modular SDK)
  // OAuthProvider.credentialFromError() is the modern API - error.credential is empty
  const credentialFromError = OAuthProvider.credentialFromError(error);
  const existingProviderId =
    error.customData?._tokenResponse?.verifiedProvider?.[0] ||
    credentialFromError?.providerId ||
    error.customData?.providerId;

  // Note: fetchSignInMethodsForEmail removed - deprecated (email enumeration risk)
  // The above 3 methods should cover all cases for account-exists-with-different-credential
  if (!existingProviderId) return null;

  return getAuthPartnerIdByFirebaseId(existingProviderId);
}

/**
 * Complete Firebase authentication orchestrator
 *
 * Handles all Firebase authentication operations with smart recovery,
 * store updates, and partner state management.
 *
 * **Responsibilities:**
 * - Firebase SDK operations (via SDK layer)
 * - Store updates via domain methods
 * - Partner state management (loading, error, idle)
 * - Security verification (roles, tiers, features)
 * - Toast notifications for user feedback
 *
 * **Error Handling:**
 * - Calls handleSmartRecovery which wraps errors
 * - Updates partner state on error
 * - Re-throws already-wrapped errors (no double wrapping)
 *
 * **Usage:**
 * ```typescript
 * const firebaseAuth = getFirebaseAuth();
 * firebaseAuth.setStore(authStore);
 * await firebaseAuth.initialize();
 * const result = await firebaseAuth.signInWithEmail(email, password);
 * ```
 */
type FirebaseSDKInstance = ReturnType<typeof getFirebaseSDK>;

/**
 * Firebase Authentication class
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export class FirebaseAuth implements AuthProvider {
  private sdk: FirebaseSDKInstance;
  private initialized = false;
  private store: (AuthState & AuthActions) | null = null;
  private popupTimeout: ReturnType<typeof setTimeout> | null = null;
  private claimsCache: ClaimsCache | null = null;
  /** Optional security context - injected via setSecurity() */
  private security: SecurityContext | null = null;

  constructor() {
    this.sdk = getFirebaseSDK();
  }

  /**
   * Inject a SecurityContext for rate limiting + audit logging.
   * Call after construction: `auth.setSecurity(security)`.
   */
  setSecurity(security: SecurityContext): void {
    this.security = security;
  }

  /**
   * Set store reference for state updates
   *
   * Must be called before initialize() to enable store updates.
   * Called by useAuth on initialization.
   *
   * @param store - Zustand auth store instance
   */
  setStore(store: AuthState & AuthActions): void {
    this.store = store;
  }

  /**
   * Get store state with validation
   *
   * Throws if store not set. Single source of truth for store access.
   *
   * @returns Store state
   * @throws Error if store not set
   * @private
   */
  private get storeState() {
    if (!this.store) {
      throw new Error('[FirebaseAuth] Store not set. Call setStore() first.');
    }
    return this.store;
  }

  /**
   * Initialize Firebase Auth service
   *
   * Lazy loads Firebase SDK and processes any pending redirect results.
   * Safe to call multiple times (idempotent).
   *
   * @throws DoNotDevError if initialization fails
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await this.sdk.initialize();

      // Process redirects BEFORE marking as initialized
      // This ensures redirect processing completes before auth is considered ready
      // Suppress notifications during init (graceful degradation when Firebase not configured)
      try {
        await this.processRedirectResult(true); // suppressNotifications = true
      } catch (error) {
        // Log but don't fail init - auth still works
        // Silent degradation - don't show toast for init failures
        handleError(error, {
          userMessage: 'Redirect processing failed',
          context: { operation: 'processRedirectResult' },
          severity: 'warning',
          showNotification: false,
        });
      }

      // Mark initialized AFTER redirect processing
      this.initialized = true;
    } catch (error) {
      // Silent degradation - don't show toast for init failures
      // Toast only for user-initiated actions
      throw handleError(error, {
        userMessage: 'Failed to initialize authentication',
        showNotification: false,
      });
    }
  }

  /**
   * Process redirect result in background (non-blocking)
   *
   * This runs asynchronously after initialization completes.
   * If there's a redirect result, it updates the store and shows toast.
   * If there's no redirect or an error, it fails silently.
   *
   * @param suppressNotifications - If true, don't show toasts for errors (used during init)
   * @private
   */
  private async processRedirectResult(
    suppressNotifications: boolean = false
  ): Promise<void> {
    // SET: Loading true
    if (this.store) {
      this.store.setLoading(true);
    }

    try {
      // Timeout protection (10 seconds)
      const timeoutPromise = new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error('Redirect check timeout')), 10000)
      );

      // Race: redirect check vs timeout
      const redirectResult = await Promise.race([
        this.sdk.getRedirectResult(),
        timeoutPromise,
      ]).catch((error) => {
        if (error.message === 'Redirect check timeout') {
          return null;
        }
        throw error;
      });

      if (redirectResult?.user) {
        // Update store with authenticated user
        await this.handleAuthStateChange(redirectResult.user);

        // Check for pending linking
        await this.checkPendingLinking();

        // Clear pending auth partnerId on success
        safeSessionStorage.removeItem('pendingAuthPartnerId');

        toast('success', 'Signed in successfully!');
      }
      // Note: null redirectResult is normal (no redirect in progress), no action needed
    } catch (error: any) {
      // Handle account linking error specifically (redirect flow)
      if (error.code === 'auth/account-exists-with-different-credential') {
        // Use OAuthProvider.credentialFromError() for modular SDK
        const firebaseProviderId =
          OAuthProvider.credentialFromError(error)?.providerId ||
          error.customData?._tokenResponse?.providerId;
        const partnerId = firebaseProviderId
          ? getAuthPartnerIdByFirebaseId(firebaseProviderId)
          : (safeSessionStorage.getItem(
              'pendingAuthPartnerId'
            ) as AuthPartnerId | null);

        if (partnerId) {
          try {
            await handleSmartRecovery(
              error,
              () => Promise.resolve(), // No retry needed for linking
              { partnerId, method: 'redirect' },
              this.getSmartRecoveryDeps()
            );
            return; // Linking flow initiated
          } catch (linkingError) {
            handleError(linkingError, {
              userMessage: 'Failed to link accounts. Please try again.',
              showNotification: !suppressNotifications,
            });
          }
        }
      }

      // Generic error handling for other errors
      // During initialization, suppress notifications (graceful degradation)
      handleError(error, {
        userMessage: 'Authentication failed. Please try again.',
        showNotification: !suppressNotifications,
        context: { operation: 'processRedirectResult' },
      });

      // Only clear state for non-linking errors
      if (error.code !== 'auth/account-exists-with-different-credential') {
        try {
          this.clearAccountLinkingState();
          safeSessionStorage.removeItem('pendingAuthPartnerId');
        } catch (cleanupError) {
          handleError(cleanupError);
        }
      }
    } finally {
      // SET: Loading false
      if (this.store) {
        this.store.setLoading(false);
      }
    }
  }

  /**
   * Ensure initialized before operations
   *
   * @throws Error if not initialized
   * @private
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('FirebaseAuth not initialized. Call initialize() first.');
    }
  }

  /**
   * Get AppConfig (helper method)
   */
  private getAppConfig(): AppConfig | null {
    if (typeof globalThis !== 'undefined') {
      const config = (globalThis as any)._DNDEV_APP_CONFIG_ as
        | AppConfig
        | undefined;
      if (config) return config;
    }
    return null;
  }

  /**
   * Initialize claims cache with AppConfig
   */
  private initializeClaimsCache(): void {
    if (this.claimsCache) return;

    const config = this.getAppConfig();
    const offlineTrustEnabled = config?.features?.offlineTrustEnabled ?? false;

    this.claimsCache = new ClaimsCache({
      offlineTrustEnabled,
      userId: this.storeState?.userId ?? null,
    });
  }

  // ==========================================================================
  // Auth State Listener
  // ==========================================================================

  /**
   * Subscribe to Firebase auth state changes
   *
   * Updates store directly with complete auth state (user, subscription, profile).
   * Checks for pending account linking after authentication.
   *
   * **Store Updates:**
   * - Authenticated: setAuthenticated(user, subscription, profile)
   * - Unauthenticated: setUnauthenticated()
   * - Partner states: clearAllPartnerStates()
   *
   * @param callback - Callback function receiving AuthUser or null
   * @returns Unsubscribe function
   */
  onAuthStateChanged(callback: (user: AuthUser | null) => void): () => void {
    return this.sdk.onAuthStateChanged(
      async (firebaseUser: FirebaseUser | null) => {
        // Update store FIRST
        if (firebaseUser) {
          await this.handleAuthStateChange(firebaseUser);
        } else {
          this.handleSignOut();
        }

        // THEN check for pending linking (user now in store)
        if (firebaseUser) {
          await this.checkPendingLinking();
        }

        // Notify callback
        const authUser = firebaseUser
          ? this.convertToAuthUser(firebaseUser)
          : null;
        callback(authUser);
      }
    );
  }

  /**
   * Handle authenticated state change
   *
   * Updates store with user, subscription claims (from Firebase), and profile.
   * Clears all partner states on successful authentication.
   *
   * **Source of Truth:** Firebase custom claims for subscription data
   *
   * @param firebaseUser - Firebase user object
   * @private
   */
  private async handleAuthStateChange(
    firebaseUser: FirebaseUser
  ): Promise<void> {
    if (!this.store) return;

    const user = this.convertToAuthUser(firebaseUser);

    // Initialize and update ClaimsCache userId
    this.initializeClaimsCache();
    if (this.claimsCache) {
      this.claimsCache.setUserId(user.id);
    }

    // Clear all partner states on successful authentication
    this.storeState.clearAllPartnerStates();

    // Get custom claims for subscription data (source of truth)
    let subscription: UserSubscription = {
      userId: user.id,
      tier: SUBSCRIPTION_TIERS.FREE,
      status: 'active',
      isActive: true,
      features: [],
      subscriptionId: null,
      customerId: user.id,
      subscriptionEnd: null,
      cancelAtPeriodEnd: false,
      updatedAt: new Date().toISOString(),
    };

    // Extract role from custom claims
    let userRole: string = USER_ROLES.USER;

    try {
      const tokenResult = await this.sdk.getIdTokenResult(firebaseUser, true);
      const claims = tokenResult?.claims || {};

      // Debug: Log claims to help diagnose issues
      if (isDev()) {
        console.log('[FirebaseAuth] Custom claims:', claims);
      }

      // Extract subscription claims
      if (claims.subscription) {
        const subscriptionClaims = claims.subscription as SubscriptionClaims;
        subscription = {
          userId: user.id,
          tier: subscriptionClaims.tier || SUBSCRIPTION_TIERS.FREE,
          status: subscriptionClaims.status || 'active',
          isActive: subscriptionClaims.status === 'active',
          features: (subscriptionClaims as any).features || [],
          subscriptionId: subscriptionClaims.subscriptionId || null,
          customerId: subscriptionClaims.customerId || user.id,
          subscriptionEnd: subscriptionClaims.subscriptionEnd || null,
          cancelAtPeriodEnd: Boolean(subscriptionClaims.cancelAtPeriodEnd),
          updatedAt: subscriptionClaims.updatedAt || new Date().toISOString(),
        };
      }

      // Extract role from custom claims using centralized utility
      // Handles 'role' string and legacy boolean flags (isAdmin, isSuper)
      userRole = getRoleFromClaims(claims);

      if (isDev()) {
        console.log(
          '[FirebaseAuth] Role extracted:',
          userRole,
          'from claims:',
          claims
        );
      }
    } catch (error: any) {
      // Network errors are expected when Firebase isn't configured or offline
      // Fail silently to avoid noise in console
      const isNetworkError =
        error?.code === 'auth/network-request-failed' ||
        error?.originalCode === 'auth/network-request-failed' ||
        error?.message?.includes('network');

      if (!isNetworkError) {
        handleError(error, {
          userMessage: 'Failed to get custom claims',
          context: { operation: 'getCustomClaims' },
          severity: 'warning',
        });
      }
    }

    // Set role on user object
    user.role = userRole;

    if (isDev()) {
      console.log(
        '[FirebaseAuth] Setting user role:',
        userRole,
        'on user:',
        user.id
      );
    }

    // Create user profile with role from claims
    const profile: UserProfile = {
      ...createDefaultUserProfile(user.id),
      role: userRole,
    };

    if (isDev()) {
      console.log('[FirebaseAuth] User profile role:', profile.role);
    }

    // Update store via domain method
    this.storeState.setAuthenticated(user, subscription, profile);
  }

  /**
   * Handle sign out state
   *
   * Clears all partner states and updates store to unauthenticated state.
   *
   * @private
   */
  private handleSignOut(): void {
    if (!this.store) return;

    // Update ClaimsCache userId
    if (this.claimsCache) {
      this.claimsCache.setUserId(null);
    }

    // Clear all partner states
    this.storeState.clearAllPartnerStates();

    // Update store via domain method
    this.storeState.setUnauthenticated();
  }

  // ==========================================================================
  // Email/Password Authentication
  // ==========================================================================

  /**
   * Sign in with email and password
   *
   * Updates partner state (password) during operation.
   *
   * **Partner State Flow:**
   * - Start: LOADING
   * - Success: cleared by onAuthStateChanged
   * - Error: ERROR
   *
   * **Smart Recovery:**
   * - Network issues → Retry with backoff
   * - Rate limiting → Exponential backoff
   *
   * @param email - User email address
   * @param password - User password
   * @returns Auth result or null if account linking required
   * @throws DoNotDevError if sign in fails (already wrapped by handleSmartRecovery)
   */
  async signInWithEmail(
    email: string,
    password: string
  ): Promise<AuthResult | null> {
    this.ensureInitialized();

    // Set partner state to loading
    this.storeState.setPartnerState('password', PARTNER_STATE.LOADING);

    try {
      const result = await this.sdk.signInWithEmail(email, password);
      toast('success', 'Signed in successfully!');
      this.storeState.setPartnerState('password', PARTNER_STATE.IDLE);
      return this.createAuthResult(result.user);
    } catch (error: any) {
      // Use centralized smart recovery (already wraps errors)
      try {
        return await handleSmartRecovery(
          error,
          () => this.sdk.signInWithEmail(email, password),
          { email, partnerId: 'password' },
          this.getSmartRecoveryDeps()
        );
      } catch (wrappedError) {
        // Error already wrapped by handleSmartRecovery
        this.storeState.setPartnerState('password', PARTNER_STATE.ERROR);
        throw wrappedError;
      }
    }
  }

  /**
   * Create new user with email and password
   *
   * Updates partner state (password) during operation.
   * Uses smart recovery for network and rate limiting errors.
   *
   * @param email - User email address
   * @param password - User password
   * @returns Auth result with isNewUser: true
   * @throws DoNotDevError if account creation fails (already wrapped)
   */
  async createUserWithEmail(
    email: string,
    password: string,
    metadata?: SignUpMetadata
  ): Promise<AuthResult> {
    this.ensureInitialized();

    // Set partner state to loading
    this.storeState.setPartnerState('password', PARTNER_STATE.LOADING);

    try {
      const result = await this.sdk.createUserWithEmail(email, password);
      // Audit signup metadata (GDPR consent timestamp, ToS version)
      if (metadata) {
        this.security?.audit({
          type: 'auth.signup.consent',
          userId: result.user?.uid,
          metadata: {
            gdpr_consent_at: metadata.gdpr_consent_at ?? '',
            ...(metadata.gdpr_tos_version
              ? { gdpr_tos_version: metadata.gdpr_tos_version }
              : {}),
          },
        });
      }
      toast('success', 'Account created successfully!');
      this.storeState.setPartnerState('password', PARTNER_STATE.IDLE);
      return this.createAuthResult(result.user, true);
    } catch (error: any) {
      try {
        const result = await handleSmartRecovery(
          error,
          () => this.sdk.createUserWithEmail(email, password),
          { email, partnerId: 'password' },
          this.getSmartRecoveryDeps()
        );
        if (!result) {
          throw new Error('Account creation failed');
        }
        return result;
      } catch (wrappedError) {
        // Error already wrapped by handleSmartRecovery
        this.storeState.setPartnerState('password', PARTNER_STATE.ERROR);
        throw wrappedError;
      }
    }
  }

  /** AuthProvider: sign in with email and password (returns AuthUser) */
  async signInWithEmailAndPassword(
    email: string,
    password: string
  ): Promise<AuthUser> {
    const result = await this.signInWithEmail(email, password);
    if (!result) throw new Error('Sign in did not return a result');
    return result.user;
  }

  /** AuthProvider: create user with email and password (returns AuthUser) */
  async createUserWithEmailAndPassword(
    email: string,
    password: string,
    metadata?: SignUpMetadata
  ): Promise<AuthUser> {
    const result = await this.createUserWithEmail(email, password, metadata);
    return result.user;
  }

  /** AuthProvider: update user profile (displayName, photoURL) */
  async updateUserProfile(updates: Partial<AuthUser>): Promise<void> {
    this.ensureInitialized();
    const user = await this.sdk.getCurrentUser();
    if (!user) return;
    const profile: { displayName?: string | null; photoURL?: string | null } =
      {};
    if (updates.displayName !== undefined)
      profile.displayName = updates.displayName;
    if (updates.photoURL !== undefined) profile.photoURL = updates.photoURL;
    if (Object.keys(profile).length === 0) return;
    await this.sdk.updateProfile(user, profile);
  }

  /** AuthProvider: get current access token */
  async getAccessToken(): Promise<string | null> {
    const user = await this.sdk.getCurrentUser();
    if (!user) return null;
    try {
      return await this.sdk.getIdToken(user, false);
    } catch {
      return null;
    }
  }

  /** AuthProvider: refresh token and return it */
  async refreshToken(): Promise<string | null> {
    const user = await this.sdk.getCurrentUser();
    if (!user) return null;
    try {
      return await this.sdk.getIdToken(user, true);
    } catch {
      return null;
    }
  }

  // ==========================================================================
  // OAuth Authentication
  // ==========================================================================

  /**
   * Sign in with OAuth partner
   *
   * Includes partner state management, popup timeout handling, and smart recovery.
   * Supports both popup and redirect flows.
   *
   * **Partner State Flow:**
   * - Start: LOADING
   * - Success: cleared by onAuthStateChanged
   * - User cancelled: IDLE
   * - Error: ERROR
   *
   * **Smart Recovery:**
   * - User cancelled → Return null
   * - Account exists → Intelligent linking
   * - Network issues → Retry with backoff
   *
   * @param partnerId - Partner identifier (google, github, etc.)
   * @param method - Authentication method ('popup' or 'redirect')
   * @returns Auth result, null if cancelled/linking, or null if redirect initiated
   * @throws DoNotDevError if authentication fails (already wrapped)
   */
  async signInWithPartner(
    partnerId: AuthPartnerId,
    method?: AuthMethod
  ): Promise<AuthResult | null> {
    const authMethod = getAuthMethod(method);
    this.ensureInitialized();

    // Set partner state to loading
    this.storeState.setPartnerState(partnerId, PARTNER_STATE.LOADING);

    try {
      const provider = this.createProviderFromConfig(partnerId);

      let result;
      if (authMethod === 'popup') {
        result = await this.handlePopupAuth(partnerId, async () => {
          return await this.sdk.signInWithPopup(provider);
        });

        if (result === null) {
          // User cancelled
          this.storeState.setPartnerState(partnerId, PARTNER_STATE.IDLE);
          return null;
        }

        toast('success', 'Signed in successfully!');
        this.storeState.setPartnerState(partnerId, PARTNER_STATE.IDLE);
        return this.createAuthResult(result.user);
      } else {
        // Store partnerId for redirect recovery (fallback if not in error object)
        safeSessionStorage.setItem('pendingAuthPartnerId', partnerId);
        await this.sdk.signInWithRedirect(provider);
        return null; // Redirect initiated
      }
    } catch (error: any) {
      try {
        const result = await handleSmartRecovery(
          error,
          () => {
            const provider = this.createProviderFromConfig(partnerId);
            return authMethod === 'popup'
              ? this.sdk.signInWithPopup(provider)
              : this.sdk.signInWithRedirect(provider);
          },
          { partnerId, method: authMethod },
          this.getSmartRecoveryDeps()
        );

        // Account linking returns null when user needs to take action
        if (result === null) {
          this.storeState.setPartnerState(partnerId, PARTNER_STATE.IDLE);
          return null;
        }

        return result;
      } catch (wrappedError) {
        // Error already wrapped by handleSmartRecovery
        this.storeState.setPartnerState(partnerId, PARTNER_STATE.ERROR);
        throw wrappedError;
      }
    }
  }

  /**
   * Link OAuth partner to current user account
   *
   * Links an additional OAuth provider to the current user's account.
   * Uses redirect by default for consistency with OAuth→OAuth auto-linking.
   *
   * **Error Handling:**
   * - operation-not-allowed → Linking disabled in Firebase console
   * - provider-already-linked → Provider already linked
   * - credential-already-in-use → Credential used by another account
   * - requires-recent-login → User needs to re-authenticate
   *
   * @param partnerId - Partner identifier (google, github, etc.)
   * @param method - Authentication method ('popup' or 'redirect', defaults to 'redirect')
   * @returns Auth result or null if redirect initiated
   * @throws DoNotDevError if linking fails (already wrapped)
   */
  async linkWithPartner(
    partnerId: AuthPartnerId,
    method?: AuthMethod
  ): Promise<AuthResult | null> {
    // Use getAuthMethod for consistent dev/prod behavior (popup in dev, redirect in prod)
    const authMethod = getAuthMethod(method);
    this.ensureInitialized();

    // Get current user
    const currentUser = await this.sdk.getCurrentUser();
    if (!currentUser) {
      throw handleError(new Error('No authenticated user'), {
        userMessage: 'You must be signed in to link accounts',
        context: { operation: 'linkWithPartner', partnerId },
        showNotification: true,
      });
    }

    // Set partner state to loading
    this.storeState.setPartnerState(partnerId, PARTNER_STATE.LOADING);

    try {
      const provider = this.createProviderFromConfig(partnerId);

      if (authMethod === 'popup') {
        const result = await this.sdk.linkWithPopup(currentUser, provider);
        toast('success', `Successfully linked ${partnerId} account!`);
        this.storeState.setPartnerState(partnerId, PARTNER_STATE.IDLE);
        return this.createAuthResult(result.user);
      } else {
        await this.sdk.linkWithRedirect(currentUser, provider);
        return null; // Redirect initiated
      }
    } catch (error: unknown) {
      // Map common linking errors to user-friendly messages
      const firebaseError = error as { code?: string };
      let userMessage = 'Failed to link account';
      let context = {
        operation: 'linkWithPartner',
        partnerId,
        errorCode: firebaseError.code,
      };

      switch (firebaseError.code) {
        case 'auth/operation-not-allowed':
          userMessage =
            'Account linking is disabled. Contact support for assistance.';
          break;
        case 'auth/provider-already-linked':
          userMessage = 'This account is already linked to your profile.';
          break;
        case 'auth/credential-already-in-use':
          userMessage = 'This account is already linked to another profile.';
          break;
        case 'auth/requires-recent-login':
          userMessage =
            'Please sign out and sign back in, then try linking again.';
          break;
        default:
          userMessage = `Failed to link ${partnerId} account. Please try again.`;
      }

      this.storeState.setPartnerState(partnerId, PARTNER_STATE.ERROR);

      throw handleError(error, {
        userMessage,
        context,
        showNotification: true,
      });
    }
  }

  /**
   * Handle popup authentication with timeout management
   *
   * Sets up 30-second timeout and properly handles user cancellation.
   * Cleans up timeout on completion.
   *
   * @param partnerId - Partner identifier for state tracking
   * @param authPromise - Async function returning authentication promise
   * @returns Authentication result or null if cancelled
   * @throws Error if authentication fails
   * @private
   */
  private async handlePopupAuth(
    partnerId: AuthPartnerId,
    authPromise: () => Promise<any>
  ): Promise<any> {
    // Clear any existing timeout before setting a new one
    this.clearPopupMonitoring();

    // Set up timeout (30 seconds)
    this.popupTimeout = setTimeout(() => {
      this.storeState.setPartnerState(partnerId, PARTNER_STATE.IDLE);
      this.clearPopupMonitoring();
    }, 30000);

    try {
      const result = await authPromise();
      this.clearPopupMonitoring();
      return result;
    } catch (error: any) {
      this.clearPopupMonitoring();

      // User cancelled - return null (not an error)
      if (
        error.code === 'auth/popup-closed-by-user' ||
        error.code === 'auth/cancelled-popup-request'
      ) {
        return null;
      }

      throw error;
    }
  }

  /**
   * Clear popup monitoring timeout
   *
   * @private
   */
  private clearPopupMonitoring(): void {
    if (this.popupTimeout) {
      clearTimeout(this.popupTimeout);
      this.popupTimeout = null;
    }
  }

  /**
   * Sign in with Google credential (for Google One Tap)
   *
   * Specialized method for Google One Tap sign-in flow.
   * Updates Google partner state during operation.
   *
   * @param credential - Google credential token
   * @returns Auth result or null if account linking required
   * @throws DoNotDevError if sign in fails (already wrapped)
   */
  async signInWithGoogleCredential(
    credential: string
  ): Promise<AuthResult | null> {
    this.ensureInitialized();

    // Set Google partner to loading
    this.storeState.setPartnerState('google', PARTNER_STATE.LOADING);

    try {
      const result = await this.sdk.signInWithGoogleCredential(credential);
      toast('success', 'Signed in with Google!');
      this.storeState.setPartnerState('google', PARTNER_STATE.IDLE);
      return this.createAuthResult(result.user);
    } catch (error: any) {
      try {
        return await handleSmartRecovery(
          error,
          () => this.sdk.signInWithGoogleCredential(credential),
          { partnerId: 'google', method: 'redirect' as AuthMethod },
          this.getSmartRecoveryDeps()
        );
      } catch (wrappedError) {
        // Error already wrapped by handleSmartRecovery
        this.storeState.setPartnerState('google', PARTNER_STATE.ERROR);
        throw wrappedError;
      }
    }
  }

  /**
   * Process redirect result
   *
   * Called during initialization to handle OAuth redirect flows.
   * Returns result if redirect completed, null if no redirect.
   *
   * @returns Auth result or null if no redirect result
   * @throws DoNotDevError if redirect processing fails (already wrapped)
   */
  async getRedirectResult(): Promise<AuthResult | null> {
    this.ensureInitialized();

    try {
      const result = await this.sdk.getRedirectResult();
      if (result?.user) {
        toast('success', 'Signed in successfully!');
        return this.createAuthResult(result.user);
      }
      return null;
    } catch (error: any) {
      try {
        return await handleSmartRecovery(
          error,
          () => this.sdk.getRedirectResult(),
          { method: 'redirect' as AuthMethod },
          this.getSmartRecoveryDeps()
        );
      } catch (wrappedError) {
        // Error already wrapped by handleSmartRecovery
        throw wrappedError;
      }
    }
  }

  /**
   * Check if Firebase completed account linking
   *
   * Called after auth state changes to complete pending account linking.
   * Manages sessionStorage state and credential recreation.
   *
   * **Linking Flow:**
   * 1. Check sessionStorage for pending linking info
   * 2. Verify user is authenticated
   * 3. Check if new provider already linked
   * 4. Recreate credential from stored data
   * 5. Link credential to user account
   * 6. Clear linking state
   *
   * @throws DoNotDevError if linking fails
   */
  async checkPendingLinking(): Promise<void> {
    const linkingInfoStr = safeSessionStorage.getItem('accountLinkingInfo');
    const originalCredentialStr =
      safeSessionStorage.getItem('originalCredential');

    if (!linkingInfoStr || !originalCredentialStr) {
      return;
    }

    try {
      const linkingInfo = JSON.parse(linkingInfoStr);
      const envelope = JSON.parse(originalCredentialStr);

      // Check TTL — clear expired credential
      if (envelope.expiresAt && Date.now() > envelope.expiresAt) {
        clearAccountLinkingState();
        return;
      }

      // Support both envelope format (with TTL) and legacy raw format
      const originalCredential = envelope.data ?? envelope;

      // Use SDK directly (more reliable during auth state change)
      const firebaseUser = await this.sdk.getCurrentUser();
      if (!firebaseUser) {
        return;
      }

      // Convert to AuthUser for provider checking
      const user = this.convertToAuthUser(firebaseUser);

      const newProviderConfig =
        AUTH_PARTNERS[linkingInfo.newProvider as AuthPartnerId];
      if (!newProviderConfig) {
        return;
      }

      const hasNewProvider =
        user.providerData?.some(
          (p: any) => p.providerId === newProviderConfig.firebaseProviderId
        ) || false;

      if (hasNewProvider) {
        this.clearAccountLinkingState();
        return;
      }

      // Attempt to link the original credential
      const credential =
        this.createCredentialFromStoredData(originalCredential);
      if (!credential) {
        this.clearAccountLinkingState();
        return;
      }

      await this.sdk.linkWithCredential(firebaseUser, credential);

      // Clear linking state only after successful linking
      this.clearAccountLinkingState();

      // Show success toast
      toast('success', 'Accounts linked successfully!');
    } catch (error: any) {
      this.clearAccountLinkingState();
      throw handleError(error, {
        userMessage: 'Account linking failed',
        showNotification: true,
      });
    }
  }

  // ==========================================================================
  // Email Link Authentication
  // ==========================================================================

  /**
   * Send sign-in link to email
   *
   * Sends passwordless sign-in link to user's email.
   * User clicks link to complete authentication.
   *
   * @param email - User email address
   * @param actionCodeSettings - Optional action code settings
   * @throws DoNotDevError if sending fails
   */
  async sendSignInLinkToEmail(
    email: string,
    actionCodeSettings?: { url: string; handleCodeInApp: boolean }
  ): Promise<void> {
    this.ensureInitialized();

    try {
      if (!actionCodeSettings?.url) {
        throw new Error(
          'sendSignInLinkToEmail requires actionCodeSettings with a non-empty "url". ' +
            'Pass { url: "https://yourapp.com/finishSignIn", handleCodeInApp: true }.'
        );
      }
      await this.sdk.sendSignInLinkToEmail(email, actionCodeSettings);
      toast('success', 'Sign-in link sent to your email!');
    } catch (error) {
      throw handleError(error, {
        userMessage: 'Failed to send sign-in link',
        showNotification: true,
      });
    }
  }

  /**
   * Sign in with email link
   *
   * Completes email link authentication flow.
   * Updates emailLink partner state during operation.
   *
   * @param email - User email address
   * @param emailLink - Optional email link (defaults to current URL)
   * @returns Auth result or null if account linking required
   * @throws DoNotDevError if sign in fails (already wrapped)
   */
  async signInWithEmailLink(
    email: string,
    emailLink?: string
  ): Promise<AuthResult | null> {
    this.ensureInitialized();

    // Set emailLink partner to loading
    this.storeState.setPartnerState('emailLink', PARTNER_STATE.LOADING);

    try {
      const result = await this.sdk.signInWithEmailLink(email, emailLink);
      toast('success', 'Signed in successfully!');
      this.storeState.setPartnerState('emailLink', PARTNER_STATE.IDLE);
      return this.createAuthResult(result.user);
    } catch (error: any) {
      try {
        return await handleSmartRecovery(
          error,
          () => this.sdk.signInWithEmailLink(email, emailLink),
          { email, partnerId: 'emailLink' },
          this.getSmartRecoveryDeps()
        );
      } catch (wrappedError) {
        // Error already wrapped by handleSmartRecovery
        this.storeState.setPartnerState('emailLink', PARTNER_STATE.ERROR);
        throw wrappedError;
      }
    }
  }

  /**
   * Check if current URL is a sign-in link
   *
   * @param emailLink - Optional URL to check (defaults to current URL)
   * @returns True if URL is a valid sign-in link
   */
  isSignInWithEmailLink(emailLink?: string): boolean {
    if (!emailLink && !isClient()) {
      return false;
    }
    const linkToCheck = emailLink || (isClient() ? window.location.href : '');
    return this.sdk.isSignInWithEmailLink(linkToCheck);
  }

  // ==========================================================================
  // Password Management
  // ==========================================================================

  /**
   * Send password reset email
   *
   * Sends password reset email to user.
   * User clicks link to reset their password.
   *
   * @param email - User email address
   * @throws DoNotDevError if sending fails
   */
  async sendPasswordResetEmail(email: string): Promise<void> {
    this.ensureInitialized();

    // Rate-limit password reset requests to prevent email flooding and enumeration.
    if (this.security) {
      await this.security.checkRateLimit(`password_reset:${email}`, 'write');
    }

    try {
      const actionCodeSettings = {
        url: this.getPasswordResetRedirectUrl(),
        handleCodeInApp: true,
      };
      await this.sdk.sendPasswordResetEmail(email, actionCodeSettings);
      this.security?.audit({ type: 'auth.password.reset' });
      toast('success', 'Password reset email sent!');
    } catch (error) {
      throw handleError(error, {
        userMessage: 'Failed to send password reset email',
        showNotification: true,
      });
    }
  }

  getPasswordResetRedirectUrl(): string {
    if (!isClient()) return '';
    // Redirect to origin - PasswordResetCallback overlay auto-detects
    // query params (?oobCode=xxx&mode=resetPassword) on any page
    return window.location.origin;
  }

  async verifyPasswordResetCode(code: string): Promise<string | null> {
    this.ensureInitialized();
    try {
      const email = await this.sdk.verifyPasswordResetCode(code);
      return email;
    } catch {
      return null;
    }
  }

  async confirmPasswordReset(code: string, newPassword: string): Promise<void> {
    this.ensureInitialized();
    try {
      await this.sdk.confirmPasswordReset(code, newPassword);
    } catch (error) {
      throw handleError(error, {
        userMessage: 'Failed to reset password',
        showNotification: true,
      });
    }
  }

  /**
   * Update current user password
   *
   * Updates password for currently authenticated user.
   * Requires recent authentication.
   *
   * @param newPassword - New password
   * @throws DoNotDevError if update fails or no authenticated user
   */
  async updatePassword(newPassword: string): Promise<void> {
    this.ensureInitialized();

    const user = await this.sdk.getCurrentUser();
    if (!user) {
      throw handleError(new Error('No authenticated user'), {
        userMessage: 'You must be signed in to update your password',
        showNotification: true,
      });
    }

    try {
      await this.sdk.updatePassword(user, newPassword);
      toast('success', 'Password updated successfully!');
    } catch (error) {
      throw handleError(error, {
        userMessage: 'Failed to update password',
        showNotification: true,
      });
    }
  }

  // ==========================================================================
  // Email Verification
  // ==========================================================================

  /**
   * Send email verification
   *
   * Sends verification email to current user's email address.
   * Updates store email verification status.
   *
   * @throws DoNotDevError if sending fails or no authenticated user
   */
  async sendEmailVerification(): Promise<void> {
    this.ensureInitialized();

    const user = await this.sdk.getCurrentUser();
    if (!user) {
      throw handleError(new Error('No authenticated user'), {
        userMessage: 'You must be signed in to verify your email',
        showNotification: true,
      });
    }

    try {
      this.storeState.setEmailVerificationStatus(
        EMAIL_VERIFICATION_STATUS.PENDING
      );
      await this.sdk.sendEmailVerification(user);
      // Don't change status to VERIFIED - it stays PENDING until user verifies
      toast('success', 'Verification email sent!');
    } catch (error) {
      // Reset to previous status on error
      this.storeState.setEmailVerificationStatus(
        EMAIL_VERIFICATION_STATUS.PENDING
      );
      throw handleError(error, {
        userMessage: 'Failed to send verification email',
        showNotification: true,
      });
    }
  }

  /**
   * Get email verification status
   *
   * Checks if current user's email is verified.
   *
   * @returns Verification status object
   */
  async getEmailVerificationStatus(): Promise<{
    status: string;
    error?: string;
  }> {
    this.ensureInitialized();

    const user = await this.sdk.getCurrentUser();
    if (!user) {
      return { status: 'pending', error: 'No authenticated user' };
    }

    return {
      status: user.emailVerified ? 'verified' : 'pending',
    };
  }

  /**
   * Check if email verification is enabled
   *
   * @returns Always true (email verification is always available)
   */
  async isEmailVerificationEnabled(): Promise<boolean> {
    return true;
  }

  // ==========================================================================
  // Security & Claims
  // ==========================================================================

  /**
   * Get ID token result with claims
   *
   * Fetches Firebase ID token with custom claims.
   * Use forceRefresh to get latest claims from server.
   *
   * @param forceRefresh - Force refresh token from server
   * @returns Token result with claims or null if no user
   */
  async getIdTokenResult(forceRefresh = false): Promise<any | null> {
    this.ensureInitialized();

    const user = await this.sdk.getCurrentUser();
    if (!user) return null;

    try {
      return await this.sdk.getIdTokenResult(user, forceRefresh);
    } catch (error) {
      throw handleError(error, {
        userMessage: 'Failed to get authentication token',
      });
    }
  }

  /**
   * Get fresh custom claims from Firebase
   *
   * Uses ClaimsCache for graceful degradation:
   * - Online: Always verify with server
   * - Offline: Use cached claims if offlineTrustEnabled=true
   * - Server: Return {} (safe default)
   *
   * @returns Custom claims object
   */
  async getCustomClaims(): Promise<Record<string, any>> {
    this.ensureInitialized();
    this.initializeClaimsCache();

    const user = await this.sdk.getCurrentUser();
    if (!user) return {};

    if (!this.claimsCache) {
      try {
        const tokenResult = await this.sdk.getIdTokenResult(user, true);
        return tokenResult?.claims || {};
      } catch (error) {
        throw handleError(error, {
          userMessage: 'Failed to get user permissions',
        });
      }
    }

    return this.claimsCache.getClaims(async () => {
      const tokenResult = await this.sdk.getIdTokenResult(user, true);
      return tokenResult?.claims || {};
    });
  }

  /**
   * Get specific custom claim
   *
   * @param claim - Claim name to retrieve
   * @returns Claim value or null if not found
   */
  async getCustomClaim(claim: string): Promise<any> {
    this.ensureInitialized();

    try {
      const claims = await this.getCustomClaims();
      return claims[claim] ?? null;
    } catch (error) {
      throw handleError(error, {
        userMessage: 'Failed to get user permission',
      });
    }
  }

  /**
   * Verify user role with Firebase
   *
   * Performs real-time verification by fetching fresh custom claims.
   * Updates store with verified role data.
   *
   * **Security:** Force refreshes token for latest role data.
   *
   * @param role - Role to verify against user's current role
   * @returns True if user has the specified role
   * @throws DoNotDevError if verification fails
   */
  async hasRole(role: string): Promise<boolean> {
    this.ensureInitialized();

    try {
      const realRole = await this.getCustomClaim('role');

      // Update store with verified role
      if (this.store && realRole) {
        const currentProfile = this.storeState.userProfile;
        if (currentProfile) {
          this.storeState.setAuthenticated(
            this.storeState.user!,
            this.storeState.userSubscription!,
            { ...currentProfile, role: realRole }
          );
        }
      }

      return hasRoleAccess(realRole, role);
    } catch (error) {
      throw handleError(error, {
        userMessage: 'Failed to verify user role',
      });
    }
  }

  /**
   * Verify user subscription tier with Firebase
   *
   * Uses ClaimsCache for graceful degradation
   *
   * @param tier - Subscription tier to verify
   * @returns True if user has the specified tier
   * @throws DoNotDevError if verification fails
   */
  async hasTier(tier: string): Promise<boolean> {
    this.ensureInitialized();
    this.initializeClaimsCache();

    try {
      const claims = await this.getCustomClaims();
      const realTier = claims.subscription?.tier;

      if (this.store && realTier) {
        const currentSubscription = this.storeState.userSubscription;
        if (currentSubscription) {
          this.storeState.setAuthenticated(
            this.storeState.user!,
            { ...currentSubscription, tier: realTier },
            this.storeState.userProfile!
          );
        }
      }

      return realTier === tier;
    } catch (error) {
      const config = this.getAppConfig();
      const offlineTrustEnabled =
        config?.features?.offlineTrustEnabled ?? false;
      const online = isClient() ? navigator.onLine : false;
      if (!offlineTrustEnabled && !online) {
        throw handleError(error, {
          userMessage: 'Failed to verify subscription tier',
        });
      }
      return false;
    }
  }

  /**
   * Verify user feature access with Firebase
   *
   * **Behavior Pattern:**
   *
   * **Online + trust enabled:**
   * 1. Trust store immediately (good UX, instant)
   * 2. Verify in background (update store if server says no)
   * 3. Revert if server says no (update store, return false)
   *
   * **Offline + trust enabled:**
   * 1. Trust store (use cached claims)
   * 2. Don't check (can't, we're offline)
   * 3. Wait until back online to verify
   *
   * **Offline + trust disabled:**
   * 1. Don't trust store
   * 2. Act as if false (reject access)
   * 3. Don't check (can't, we're offline)
   *
   * **No loading screens!** Store has claims immediately.
   *
   * @param feature - Feature to verify access
   * @returns True if user has access to the feature
   * @throws DoNotDevError if verification fails
   */
  async hasFeature(feature: string): Promise<boolean> {
    this.ensureInitialized();
    this.initializeClaimsCache();

    const cachedClaims = this.storeState.getCustomClaimsLocal();
    const cachedFeatures = cachedClaims?.features || [];
    const hasCachedFeature =
      Array.isArray(cachedFeatures) && cachedFeatures.includes(feature);

    if (!this.claimsCache) {
      try {
        const claims = await this.getCustomClaims();
        const features = claims.features || [];
        return Array.isArray(features) && features.includes(feature);
      } catch (error) {
        throw handleError(error, {
          userMessage: 'Failed to verify feature access',
        });
      }
    }

    const online = isClient() ? navigator.onLine : false;
    const config = this.getAppConfig();
    const offlineTrustEnabled = config?.features?.offlineTrustEnabled ?? false;

    if (online) {
      try {
        const claims = await this.getCustomClaims();
        const features = claims.features || [];
        const hasVerifiedFeature =
          Array.isArray(features) && features.includes(feature);

        if (hasVerifiedFeature !== hasCachedFeature) {
          return hasVerifiedFeature;
        }

        return hasVerifiedFeature;
      } catch (error) {
        return hasCachedFeature;
      }
    } else {
      if (!offlineTrustEnabled) {
        return false;
      }

      return hasCachedFeature;
    }
  }

  // ==========================================================================
  // User Operations
  // ==========================================================================

  /**
   * Get current authenticated user
   *
   * @returns AuthUser or null if not authenticated
   */
  async getCurrentUser(): Promise<AuthUser | null> {
    const firebaseUser = await this.sdk.getCurrentUser();
    return firebaseUser ? this.convertToAuthUser(firebaseUser) : null;
  }

  /**
   * Sign out current user
   *
   * Clears popup monitoring, signs out from Firebase,
   * and clears account linking state.
   *
   * @throws DoNotDevError if sign out fails
   */
  async signOut(): Promise<void> {
    this.ensureInitialized();

    // Clear popup monitoring
    this.clearPopupMonitoring();

    try {
      safeSessionStorage.removeItem('accountLinkingInfo');
      await this.clearCachedClaims();
      await this.sdk.signOut();
      toast('info', 'Signed out successfully');
    } catch (error) {
      throw handleError(error, {
        userMessage: 'Failed to sign out',
        showNotification: true,
      });
    }
  }

  /**
   * Re-authenticate user with password
   * Required before sensitive operations like account deletion
   *
   * @version 0.1.0
   * @since 0.0.1
   * @author AMBROISE PARK Consulting
   * @param password - User's password
   * @throws DoNotDevError if re-authentication fails
   */
  async reauthenticateWithPassword(password: string): Promise<void> {
    this.ensureInitialized();

    const user = await this.sdk.getCurrentUser();
    if (!user || !user.email) {
      throw new Error('No authenticated user');
    }

    try {
      const credential = EmailAuthProvider.credential(user.email, password);
      await this.sdk.reauthenticateWithCredential(user, credential);
    } catch (error) {
      throw handleError(error, {
        userMessage: 'Re-authentication failed. Please check your password.',
        showNotification: true,
      });
    }
  }

  /**
   * Re-authenticate user with OAuth provider
   * Required before sensitive operations like account deletion
   *
   * Uses getAuthMethod() for consistent dev/prod behavior:
   * - Development: popup (faster, better DX)
   * - Production: redirect (more reliable, better UX)
   *
   * @version 0.1.0
   * @since 0.0.1
   * @author AMBROISE PARK Consulting
   * @param partnerId - OAuth partner identifier (google, github, etc.)
   * @param method - Authentication method ('popup' or 'redirect'). If not provided, uses getAuthMethod() default.
   * @returns Promise that resolves when reauthentication completes (popup) or null if redirect initiated
   * @throws DoNotDevError with 'REAUTH_CANCELLED' if user cancels popup
   * @throws DoNotDevError if re-authentication fails
   */
  async reauthenticateWithProvider(
    partnerId: AuthPartnerId,
    method?: AuthMethod
  ): Promise<void> {
    this.ensureInitialized();

    const user = await this.sdk.getCurrentUser();
    if (!user) {
      throw new Error('No authenticated user');
    }

    // Use getAuthMethod for consistent dev/prod behavior (popup in dev, redirect in prod)
    const authMethod = getAuthMethod(method);

    try {
      const provider = this.createProviderFromConfig(partnerId);

      if (authMethod === 'popup') {
        await this.sdk.reauthenticateWithPopup(user, provider);
      } else {
        // Redirect flow - initiate redirect and return
        await this.sdk.reauthenticateWithRedirect(user, provider);
        // Redirect initiated - page will reload after reauthentication
        return;
      }
    } catch (error: any) {
      // User cancelled popup
      if (
        error.code === 'auth/popup-closed-by-user' ||
        error.code === 'auth/cancelled-popup-request' ||
        error.code === 'auth/popup-blocked'
      ) {
        throw new Error('REAUTH_CANCELLED');
      }

      throw handleError(error, {
        userMessage: 'Re-authentication failed. Please try again.',
        showNotification: true,
      });
    }
  }

  /**
   * Get primary authentication provider from user's providerData
   * Returns OAuth provider if exists, otherwise password
   *
   * @private
   * @param user - Firebase user object
   * @returns AuthPartnerId or null if unable to determine
   */
  private getPrimaryProvider(user: FirebaseUser): AuthPartnerId | null {
    if (!user.providerData || user.providerData.length === 0) {
      return null;
    }

    // Get first provider (primary)
    const providerId = user.providerData[0]?.providerId;
    if (!providerId) return null;

    // Map Firebase provider IDs to AuthPartnerId
    if (providerId === 'password' || providerId === 'emailLink') {
      return 'password';
    }
    if (providerId.startsWith('google.com')) return 'google';
    if (providerId.startsWith('github.com')) return 'github';
    if (providerId.startsWith('microsoft.com')) return 'microsoft';
    if (providerId.startsWith('apple.com')) return 'apple';
    if (providerId.startsWith('facebook.com')) return 'facebook';
    if (providerId.startsWith('twitter.com')) return 'twitter';

    return null;
  }

  /**
   * Delete user account (GDPR Article 17)
   *
   * Handles the complete deletion flow including reauthentication:
   * 1. Attempts to delete account
   * 2. If reauthentication is required:
   *    - For OAuth providers: Automatically triggers reauthentication popup
   *    - For password providers: Uses provided password to reauthenticate
   * 3. Calls optional consumer deleteUserFunction (try/catch, don't fail)
   * 4. Deletes Firebase Auth user (ALWAYS)
   *
   * @param password - Optional password for password-based reauthentication.
   *                   Required if user's primary provider is password and reauthentication is needed.
   * @throws DoNotDevError with 'REAUTH_CANCELLED' if user cancels OAuth popup
   * @throws DoNotDevError with 'REQUIRES_PASSWORD' if password is required but not provided
   * @throws DoNotDevError if account deletion fails
   *
   * @version 0.1.0
   * @since 0.0.1
   * @author AMBROISE PARK Consulting
   */
  async deleteAccount(password?: string): Promise<void> {
    this.ensureInitialized();

    const user = await this.sdk.getCurrentUser();
    if (!user) {
      throw new Error('No authenticated user');
    }

    // Helper function to perform actual deletion
    const performDeletion = async () => {
      // 1. Call consumer's optional cleanup function (failsafe - errors don't block)
      const authConfig = this.getAppConfig()?.auth;
      const deleteUserFn =
        authConfig && typeof authConfig === 'object'
          ? authConfig.deleteUserFunction
          : undefined;
      if (deleteUserFn) {
        try {
          await deleteUserFn(user.uid);
        } catch (cleanupError) {
          if (isDev()) {
            console.error('Consumer deleteUserFunction failed:', cleanupError);
          }
          // Continue - consumer cleanup failures don't block account deletion
        }
      }

      // 2. Delete Firebase Auth user (framework responsibility - ALWAYS)
      await this.sdk.deleteUser(user);

      toast('success', 'Account deleted successfully');
    };

    try {
      // Try deletion first
      await performDeletion();
    } catch (error: any) {
      // If requires recent login, handle reauthentication
      if (error.code === 'auth/requires-recent-login') {
        const primaryProvider = this.getPrimaryProvider(user);

        if (!primaryProvider) {
          throw handleError(error, {
            userMessage: 'Unable to determine authentication provider',
            showNotification: true,
          });
        }

        // OAuth provider - auto-reauthenticate using getAuthMethod() (popup in dev, redirect in prod)
        if (primaryProvider !== 'password') {
          try {
            // Use getAuthMethod() for consistent dev/prod behavior - act like user requested reauth
            await this.reauthenticateWithProvider(primaryProvider);
            // Retry deletion after successful reauthentication
            await performDeletion();
            return;
          } catch (reauthError: any) {
            if (reauthError.message === 'REAUTH_CANCELLED') {
              throw new Error('REAUTH_CANCELLED');
            }
            throw handleError(reauthError, {
              userMessage: 'Re-authentication failed. Please try again.',
              showNotification: true,
            });
          }
        }

        // Password provider - require password parameter
        if (!password) {
          throw new Error('REQUIRES_PASSWORD');
        }

        try {
          await this.reauthenticateWithPassword(password);
          // Retry deletion after successful reauthentication
          await performDeletion();
          return;
        } catch (reauthError) {
          throw handleError(reauthError, {
            userMessage:
              'Re-authentication failed. Please check your password.',
            showNotification: true,
          });
        }
      }

      // Other errors - rethrow as-is
      throw handleError(error, {
        userMessage: 'Failed to delete account',
        showNotification: true,
      });
    }
  }

  /**
   * Set session persistence (remember me).
   * Delegates to SDK which maps boolean → Firebase persistence constants.
   */
  async setRememberMe(remember: boolean): Promise<void> {
    await this.sdk.setRememberMe(remember);
  }

  /**
   * Clear cached claims (e.g., on logout)
   */
  async clearCachedClaims(): Promise<void> {
    if (this.claimsCache) {
      await this.claimsCache.clearClaims();
    }
  }

  /**
   * Set cached claims (for debug/testing)
   * @internal
   */
  async setCachedClaims(claims: Record<string, any>): Promise<void> {
    this.initializeClaimsCache();
    if (this.claimsCache) {
      await this.claimsCache.setClaims(claims);
    }
  }

  /**
   * Clear account linking state from sessionStorage
   */
  clearAccountLinkingState(): void {
    clearAccountLinkingState();
  }

  /**
   * Reset auth state
   *
   * Resets all partner states to idle and clears errors.
   * Useful when auth gets corrupted or stuck.
   */
  resetAuthState(): void {
    if (!this.store) return;

    // Reset all partner states to idle (DRY: use AUTH_PARTNERS schema)
    Object.keys(AUTH_PARTNERS).forEach((partner) => {
      this.storeState.setPartnerState(
        partner as AuthPartnerId,
        PARTNER_STATE.IDLE
      );
    });

    // Clear any errors
    this.storeState.clearAuthError();
  }

  /**
   * Fetch sign-in methods for email
   *
   * Gets list of sign-in methods available for an email address.
   * Useful for determining which providers user has used.
   *
   * @param email - Email address to check
   * @returns Array of sign-in method strings
   *
   * @deprecated This method enables email enumeration attacks — an attacker can
   * determine whether an email address is registered by calling it. It will be
   * removed in a future version. Use the account linking flow instead
   * (see `handleAccountLinking`).
   */
  async fetchSignInMethodsForEmail(email: string): Promise<string[]> {
    console.warn(
      '[DoNotDev] fetchSignInMethodsForEmail is deprecated — it enables email enumeration attacks. Use the account linking flow instead.'
    );
    this.ensureInitialized();

    try {
      return await this.sdk.fetchSignInMethodsForEmail(email);
    } catch (error) {
      throw handleError(error, {
        userMessage: 'Failed to check sign-in methods',
      });
    }
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  /**
   * Get smart recovery dependencies
   *
   * @returns Dependencies object for smart recovery
   * @private
   */
  private getSmartRecoveryDeps(): SmartRecoveryDependencies {
    return {
      sdk: this.sdk,
      handleAccountLinking: this.handleAccountLinking.bind(this),
      createAuthResult: this.createAuthResult.bind(this),
    };
  }

  /**
   * Get account linking dependencies
   *
   * @returns Dependencies object for account linking
   * @private
   */
  private getAccountLinkingDeps(): AccountLinkingDependencies {
    return {
      sdk: this.sdk,
      createProviderFromConfig: this.createProviderFromConfig.bind(this),
      createAuthResult: this.createAuthResult.bind(this),
      getExistingProvider,
    };
  }

  /**
   * Handle account linking (wrapper for external call)
   *
   * @param error - Firebase error object
   * @param attemptedProvider - Provider user tried to sign in with
   * @param method - Authentication method (popup or redirect)
   * @returns Auth result or null if user needs to take action
   * @private
   */
  private async handleAccountLinking(
    error: any,
    attemptedProvider: AuthPartnerId,
    method: AuthMethod
  ): Promise<AuthResult | null> {
    return await handleOAuthLinking(
      error,
      attemptedProvider,
      method,
      this.getAccountLinkingDeps()
    );
  }

  /**
   * Create provider from AUTH_PARTNERS schema
   *
   * Creates Firebase auth provider based on partner configuration.
   * Applies custom parameters and scopes from AUTH_PARTNERS.
   *
   * @param partnerId - Partner identifier
   * @returns Firebase auth provider
   * @throws Error if partner not supported
   * @private
   */
  private createProviderFromConfig(partnerId: AuthPartnerId): any {
    const config = AUTH_PARTNERS[partnerId];
    if (!config || !config.firebaseProviderId) {
      throw new Error(`Unsupported partner: ${partnerId}`);
    }

    let provider;
    switch (partnerId) {
      case 'google':
        provider = this.sdk.createGoogleProvider();
        break;
      case 'github':
        provider = this.sdk.createGithubProvider();
        break;
      case 'facebook':
        provider = this.sdk.createFacebookProvider();
        break;
      case 'twitter':
        provider = this.sdk.createTwitterProvider();
        break;
      case 'microsoft':
        provider = this.sdk.createMicrosoftProvider();
        break;
      case 'apple':
        provider = this.sdk.createAppleProvider();
        break;
      default:
        provider = this.sdk.createOAuthProvider(config.firebaseProviderId);
    }

    if (config.customParameters) {
      provider.setCustomParameters(config.customParameters);
    }

    if (config.scopes && config.scopes.length > 0) {
      config.scopes.forEach((scope: string) => provider.addScope(scope));
    }

    return provider;
  }

  /**
   * Convert Firebase user to AuthUser
   *
   * Maps Firebase user object to our AuthUser type.
   *
   * @param firebaseUser - Firebase user object
   * @returns AuthUser object
   * @private
   */
  private convertToAuthUser(firebaseUser: FirebaseUser): AuthUser {
    return {
      id: firebaseUser.uid,
      email: firebaseUser.email || null,
      displayName: firebaseUser.displayName || null,
      photoURL: firebaseUser.photoURL || null,
      emailVerified: firebaseUser.emailVerified || false,
      lastLoginAt:
        firebaseUser.metadata.lastSignInTime || new Date().toISOString(),
      providerData: firebaseUser.providerData.map((provider: UserInfo) => ({
        providerId: provider.providerId,
        uid: provider.uid,
        displayName: provider.displayName,
        email: provider.email,
        photoURL: provider.photoURL,
        phoneNumber: provider.phoneNumber,
      })),
    };
  }

  /**
   * Create AuthResult
   *
   * Converts Firebase user to AuthResult and clears account linking state.
   *
   * @param firebaseUser - Firebase user object
   * @param isNewUser - Whether this is a new user registration
   * @returns AuthResult object
   * @private
   */
  private createAuthResult(
    firebaseUser: FirebaseUser,
    isNewUser = false
  ): AuthResult {
    // Don't clear linking state here - let checkPendingLinking handle it after verification

    return {
      user: this.convertToAuthUser(firebaseUser),
      success: true,
      isNewUser,
    };
  }

  /**
   * Create credential from stored data
   *
   * Recreates Firebase credential from sessionStorage data.
   * Uses modern credentialFromJSON() API for proper deserialization.
   *
   * @param data - Stored credential JSON data from .toJSON()
   * @returns Firebase credential or null if creation fails
   * @private
   */
  private createCredentialFromStoredData(data: any): AuthCredential | null {
    try {
      if (!data || !data.providerId) return null;

      // Modern approach: Use provider-specific credentialFromJSON()
      // The data comes from credential.toJSON() which includes providerId
      switch (data.providerId) {
        case 'google.com':
          return GoogleAuthProvider.credential(
            data.idToken || null,
            data.accessToken || null
          );
        case 'github.com':
          return GithubAuthProvider.credential(data.accessToken);
        case 'facebook.com':
          return FacebookAuthProvider.credential(data.accessToken);
        case 'twitter.com':
          return TwitterAuthProvider.credential(
            data.accessToken,
            data.secret || data.oauthTokenSecret
          );
        default:
          // Generic OAuth providers (Microsoft, Apple, etc.)
          if (data.idToken) {
            return new OAuthProvider(data.providerId).credential({
              idToken: data.idToken,
              accessToken: data.accessToken,
            });
          }
          if (data.accessToken) {
            return new OAuthProvider(data.providerId).credential({
              accessToken: data.accessToken,
            });
          }
          return null;
      }
    } catch (error) {
      // Silent failure - return null without showing toast
      // This is a helper method called during OAuth flows
      handleError(error, {
        showNotification: false,
        severity: 'warning',
        context: { operation: '_getCredentialFromData' },
      });
      return null;
    }
  }

  /**
   * Reset authentication state (HMR support)
   *
   * Called during hot module replacement to reset singleton state.
   * Internal method for development only.
   *
   * @internal
   */
  reset(): void {
    this.initialized = false;
    this.sdk = getFirebaseSDK();
    this.store = null;
    this.claimsCache = null;
    if (this.popupTimeout) {
      clearTimeout(this.popupTimeout);
      this.popupTimeout = null;
    }
  }
}

/**
 * Singleton instance
 *
 * Use this to get the FirebaseAuth instance throughout your app.
 *
 * @example
 * ```typescript
 * const firebaseAuth = getFirebaseAuth();
 * await firebaseAuth.initialize();
 * ```
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const getFirebaseAuth = createSingleton(() => new FirebaseAuth());

// ❌ REMOVED: HMR disposal block
// Zustand handles HMR correctly, no manual disposal needed
