// packages/providers/firebase/src/client/FirebaseAccountLinking.ts

/**
 * @fileoverview FirebaseAccountLinking - Firebase Account Linking Logic
 * @description Handles all account linking scenarios (both error-triggered and manual). Manages the complete account linking flow with proper state management. Supports OAuth to Password, OAuth to EmailLink, OAuth to OAuth, Password to OAuth, and EmailLink to OAuth scenarios.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { toast } from '@donotdev/components';
import {
  type AuthResult,
  type AuthPartnerId,
  type AccountLinkingInfo,
  safeSessionStorage,
  isDev,
} from '@donotdev/core';
import { getAuthMethod, type AuthMethod } from '@donotdev/core';

import { OAuthProvider, type FirebaseUser } from './sdk';

import type { getFirebaseSDK } from './sdk';

type FirebaseSDKInstance = ReturnType<typeof getFirebaseSDK>;

export interface AccountLinkingDependencies {
  sdk: FirebaseSDKInstance;
  createProviderFromConfig: (partnerId: AuthPartnerId) => any;
  createAuthResult: (user: FirebaseUser, isNewUser?: boolean) => AuthResult;
  getExistingProvider: (
    sdk: FirebaseSDKInstance,
    error: any,
    email: string
  ) => Promise<AuthPartnerId | null>;
}

/**
 * Account Linking: Intelligent routing
 * Shows progress toasts and handles linking internally
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function handleOAuthLinking(
  error: any,
  attemptedProvider: AuthPartnerId,
  method: AuthMethod,
  deps: AccountLinkingDependencies
): Promise<AuthResult | null> {
  // Internal Firebase error - don't expose details to AuthService layer
  // Silence verbose logging in production builds

  const email = error.customData?.email || error.email;
  if (!email) {
    if (isDev())
      console.warn(
        '[FirebaseAccountLinking] No email found for account linking'
      );
    toast('error', 'Could not determine account email');
    throw error;
  }

  // Store original credential for later linking
  // Firebase modular SDK (v9+): Use OAuthProvider.credentialFromError() - NOT error.credential
  const credential = OAuthProvider.credentialFromError(error);

  if (credential) {
    // Use .toJSON() for proper serialization (modern Firebase API)
    // Store with TTL so credential doesn't persist indefinitely in sessionStorage
    try {
      const credentialJSON = credential.toJSON();
      const envelope = {
        data: credentialJSON,
        expiresAt: Date.now() + 5 * 60 * 1000, // 5 minute TTL
      };
      safeSessionStorage.setItem(
        'originalCredential',
        JSON.stringify(envelope)
      );
    } catch (credError) {
      if (isDev())
        console.warn(
          '[FirebaseAccountLinking] Failed to serialize credential:',
          credError
        );
    }
  } else {
    if (isDev())
      console.warn(
        '[FirebaseAccountLinking] No credential from error - linking may fail'
      );
  }

  // Dual fallback to get existing provider
  const existingProvider = await deps.getExistingProvider(
    deps.sdk,
    error,
    email
  );
  if (!existingProvider) {
    toast('error', 'Could not determine existing account type');
    throw error;
  }

  // Internal Firebase logic - don't expose to AuthService layer

  // OAuth → Password: Show password form
  if (existingProvider === 'password') {
    return await handleOAuthToEmailLinking(email, attemptedProvider, deps);
  }

  // OAuth → EmailLink: Show email link form
  if (existingProvider === 'emailLink') {
    return await handleOAuthToEmailLinkLinking(email, attemptedProvider, deps);
  }

  // Password → OAuth: Trigger OAuth flow (user tried password, account exists with OAuth)
  if (
    (attemptedProvider as string) === 'password' &&
    (existingProvider as string) !== 'password'
  ) {
    return await handlePasswordToOAuthLinking(
      email,
      existingProvider as AuthPartnerId,
      method,
      deps
    );
  }

  // EmailLink → OAuth: Trigger OAuth flow (user tried emailLink, account exists with OAuth)
  if (
    (attemptedProvider as string) === 'emailLink' &&
    (existingProvider as string) !== 'emailLink'
  ) {
    return await handleEmailLinkToOAuthLinking(
      email,
      existingProvider as AuthPartnerId,
      method,
      deps
    );
  }

  // OAuth → OAuth: Show instruction and let user sign in manually
  return await handleOAuthToOAuthLinking(
    email,
    existingProvider,
    method,
    attemptedProvider,
    deps
  );
}

/**
 * OAuth → Email: Store UI state for password form
 * Returns null to indicate manual sign-in required
 */
async function handleOAuthToEmailLinking(
  email: string,
  attemptedProvider: AuthPartnerId,
  deps: AccountLinkingDependencies
): Promise<AuthResult | null> {
  const linkingInfo: AccountLinkingInfo = {
    email,
    existingProvider: 'password',
    newProvider: attemptedProvider,
    timestamp: Date.now(),
  };

  safeSessionStorage.setItem('accountLinkingInfo', JSON.stringify(linkingInfo));
  toast(
    'info',
    `Please sign in with your password to link your ${attemptedProvider} account`
  );
  return null; // Manual sign-in required
}

/**
 * OAuth → EmailLink: Store UI state for email link form
 * Returns null to indicate manual sign-in required
 */
async function handleOAuthToEmailLinkLinking(
  email: string,
  attemptedProvider: AuthPartnerId,
  deps: AccountLinkingDependencies
): Promise<AuthResult | null> {
  const linkingInfo: AccountLinkingInfo = {
    email,
    existingProvider: 'emailLink',
    newProvider: attemptedProvider,
    timestamp: Date.now(),
  };

  safeSessionStorage.setItem('accountLinkingInfo', JSON.stringify(linkingInfo));
  toast(
    'info',
    `Please check your email for a sign-in link to link your ${attemptedProvider} account`
  );
  return null; // Manual sign-in required
}

/**
 * OAuth → OAuth: Trigger existing provider (Firebase auto-links)
 * Shows progress toasts and awaits completion
 */
async function handleOAuthToOAuthLinking(
  email: string,
  existingProvider: AuthPartnerId,
  method: AuthMethod,
  attemptedProvider: AuthPartnerId,
  deps: AccountLinkingDependencies
): Promise<AuthResult | null> {
  toast(
    'info',
    `Account linking required. Signing you in with ${existingProvider} to link your ${attemptedProvider} account...`
  );

  // Store linking info for after user signs in
  const linkingInfo: AccountLinkingInfo = {
    email,
    existingProvider: existingProvider as AuthPartnerId,
    newProvider: attemptedProvider,
    timestamp: Date.now(),
  };

  safeSessionStorage.setItem('accountLinkingInfo', JSON.stringify(linkingInfo));

  // Automatically trigger sign-in with existing provider
  const provider = deps.createProviderFromConfig(
    existingProvider as AuthPartnerId
  );
  // Respect method prop if provided, otherwise use getAuthMethod (popup in dev, redirect in prod)
  const authMethod = getAuthMethod(method);

  if (authMethod === 'popup') {
    toast(
      'info',
      `You have an existing ${existingProvider} account. Opening popup to link accounts...`
    );

    try {
      const result = await deps.sdk.signInWithPopup(provider);

      // After popup sign-in, check if we need to complete linking
      // The linking will be handled by checkPendingLinking() in onAuthStateChanged
      return deps.createAuthResult(result.user, false);
    } catch (popupError: any) {
      if (isDev()) {
        console.error(
          '[FirebaseAccountLinking] Popup sign-in failed:',
          popupError
        );
      }
      // In dev mode, don't fall back to redirect - it breaks the flow
      // Instead, show an error and ask user to allow popups
      if (
        popupError.code === 'auth/popup-blocked' ||
        popupError.code === 'auth/popup-closed-by-user'
      ) {
        toast(
          'error',
          'Popup was blocked. Please allow popups for this site and try again, or use a different browser.'
        );
        // Clear linking state since we can't complete it
        safeSessionStorage.removeItem('accountLinkingInfo');
        safeSessionStorage.removeItem('originalCredential');
        throw new Error(
          'Popup blocked. Please allow popups to complete account linking in development mode.'
        );
      }
      throw popupError;
    }
  } else {
    toast(
      'info',
      `You have an existing ${existingProvider} account. Redirecting to link accounts...`
    );

    await deps.sdk.signInWithRedirect(provider);
    return null; // Redirect initiated
  }
}

/**
 * Password → OAuth: Manual-only linking (no auto-trigger)
 * User has password account, trying to sign in with OAuth
 */
async function handlePasswordToOAuthLinking(
  email: string,
  oauthProvider: AuthPartnerId,
  method: AuthMethod,
  deps: AccountLinkingDependencies
): Promise<AuthResult | null> {
  // Long toast explaining manual linking requirement
  toast(
    'info',
    `We can't automatically link password/email accounts. First sign in using your original method, then go to Profile → Link accounts to connect this provider.`
  );

  // Store linking info for after user signs in (if they want to link later)
  const linkingInfo: AccountLinkingInfo = {
    email,
    existingProvider: 'password',
    newProvider: oauthProvider,
    timestamp: Date.now(),
  };

  safeSessionStorage.setItem('accountLinkingInfo', JSON.stringify(linkingInfo));

  // Return null - no auto-trigger, user must link from Profile
  return null;
}

/**
 * EmailLink → OAuth: Manual-only linking (no auto-trigger)
 * User has email link account, trying to sign in with OAuth
 */
async function handleEmailLinkToOAuthLinking(
  email: string,
  oauthProvider: AuthPartnerId,
  method: AuthMethod,
  deps: AccountLinkingDependencies
): Promise<AuthResult | null> {
  // Long toast explaining manual linking requirement
  toast(
    'info',
    `We can't automatically link password/email accounts. First sign in using your original method, then go to Profile → Link accounts to connect this provider.`
  );

  // Store linking info for after user signs in (if they want to link later)
  const linkingInfo: AccountLinkingInfo = {
    email,
    existingProvider: 'emailLink',
    newProvider: oauthProvider,
    timestamp: Date.now(),
  };

  safeSessionStorage.setItem('accountLinkingInfo', JSON.stringify(linkingInfo));

  // Return null - no auto-trigger, user must link from Profile
  return null;
}

/**
 * Clear account linking state from sessionStorage
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function clearAccountLinkingState(): void {
  safeSessionStorage.removeItem('accountLinkingInfo');
  safeSessionStorage.removeItem('originalCredential');
}
