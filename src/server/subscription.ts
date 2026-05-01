// packages/providers/firebase/src/server/subscription.ts

/**
 * @fileoverview Stripe subscription utilities for Firebase
 * @description Helper functions for managing Stripe subscriptions in Firestore
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import type { SubscriptionStatus } from '@donotdev/core';
import { handleError } from '@donotdev/core/server';

// W5 fix: minimal structural types for Stripe event/subscription objects
// so we avoid using `any` in production paths while not requiring the stripe package at compile time.
interface StripeEventObject {
  type: string;
  id: string;
  data: { object: StripeSubscriptionObject };
}

interface StripeSubscriptionObject {
  id: string;
  customer: string;
  status: string;
  items: { data: Array<{ plan: { id: string } }> };
  current_period_start: number;
  current_period_end: number;
  cancel_at_period_end: boolean;
  canceled_at?: number;
  metadata?: Record<string, string>;
  created: number;
}

import { getServerFirestore } from './utils';
import {
  prepareForFirestore,
  transformFirestoreData,
} from '../shared/transform';
import { handleFirebaseError } from '../shared/utils';

/**
 * Subscription data type for Firestore storage
 * This is different from SubscriptionClaims which is for Firebase Auth custom claims
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export interface SubscriptionData {
  id: string;
  customerId: string;
  status: SubscriptionStatus;
  planId: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  canceledAt?: string;
  metadata?: Record<string, string>;
  features?: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Options for subscription operations
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export interface SubscriptionOptions {
  /**
   * Collection where subscriptions are stored
   * @default "subscriptions"
   */
  collection?: string;

  /**
   * User ID field name in subscription document
   * @default "customerId"
   */
  userIdField?: string;
}

/**
 * Gets a user's active subscription
 * @param userId User ID or customer ID
 * @param options Operation options
 * @returns Active subscription or null if not found
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function getActiveSubscription(
  userId: string,
  options: SubscriptionOptions = {}
): Promise<SubscriptionData | null> {
  const { collection = 'subscriptions', userIdField = 'customerId' } = options;

  try {
    const db = await getServerFirestore();
    const query = db
      .collection(collection)
      .where(userIdField, '==', userId)
      .where('status', '==', 'active')
      .limit(1);

    const snapshot = await query.get();

    if (snapshot.empty) {
      return null;
    }

    const doc = snapshot.docs[0];
    if (!doc) {
      return null;
    }

    const data = doc.data();
    return transformFirestoreData({
      id: doc.id,
      ...data,
    }) as SubscriptionData;
  } catch (error) {
    throw handleFirebaseError(error, 'getActiveSubscription');
  }
}

/**
 * Gets all subscriptions for a user
 * @param userId User ID or customer ID
 * @param options Operation options
 * @returns Array of subscriptions
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function getUserSubscriptions(
  userId: string,
  options: SubscriptionOptions = {}
): Promise<SubscriptionData[]> {
  const { collection = 'subscriptions', userIdField = 'customerId' } = options;

  try {
    const db = await getServerFirestore();
    const query = db
      .collection(collection)
      .where(userIdField, '==', userId)
      .orderBy('createdAt', 'desc');

    const snapshot = await query.get();

    // Firestore Admin SDK QueryDocumentSnapshot has complex generics; inline structural type avoids import coupling
    return snapshot.docs.map((doc: { id: any; data: () => any }) => {
      return transformFirestoreData({
        id: doc.id,
        ...doc.data(),
      }) as SubscriptionData;
    });
  } catch (error) {
    throw handleFirebaseError(error, 'getUserSubscriptions');
  }
}

/**
 * Creates or updates a subscription
 * @param subscription Subscription data
 * @param options Operation options
 * @returns Updated subscription data
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function saveSubscription(
  subscription: SubscriptionData,
  options: SubscriptionOptions = {}
): Promise<SubscriptionData> {
  const { collection = 'subscriptions' } = options;

  try {
    const db = await getServerFirestore();
    const now = new Date().toISOString();

    // NW4 fix: do not mutate the caller's object — build a new copy with timestamps
    const subscriptionWithTimestamps: SubscriptionData = {
      ...subscription,
      createdAt: subscription.createdAt || now,
      updatedAt: now,
    };

    // Prepare data for Firestore
    const data = prepareForFirestore(subscriptionWithTimestamps);

    // Remove ID from document data
    const { id, ...docData } = data;

    // Use provided ID or generate one
    const docRef = id
      ? db.collection(collection).doc(id)
      : db.collection(collection).doc();

    // Save to Firestore
    await docRef.set(docData, { merge: true });

    // Return updated subscription with ID
    return {
      ...subscriptionWithTimestamps,
      id: docRef.id,
    };
  } catch (error) {
    throw handleFirebaseError(error, 'saveSubscription');
  }
}

/**
 * Updates a subscription status
 * @param subscriptionId Subscription ID
 * @param status New subscription status
 * @param options Operation options
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function updateSubscriptionStatus(
  subscriptionId: string,
  status: SubscriptionStatus,
  options: SubscriptionOptions = {}
): Promise<void> {
  const { collection = 'subscriptions' } = options;

  try {
    const db = await getServerFirestore();
    const docRef = db.collection(collection).doc(subscriptionId);

    await docRef.update({
      status,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    throw handleFirebaseError(error, 'updateSubscriptionStatus');
  }
}

/**
 * Checks if a user has access to a specific feature
 * @param userId User ID or customer ID
 * @param featureKey Feature key to check
 * @param options Operation options
 * @returns Whether the user has access to the feature
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function hasFeatureAccess(
  userId: string,
  featureKey: string,
  options: SubscriptionOptions = {}
): Promise<boolean> {
  try {
    // Get active subscription
    const subscription = await getActiveSubscription(userId, options);

    // No active subscription means no access
    if (!subscription) {
      return false;
    }

    // If subscription has features array, check if feature is included
    if (subscription.features && Array.isArray(subscription.features)) {
      return subscription.features.includes(featureKey);
    }

    // If subscription has metadata with feature flag, check it
    if (subscription.metadata && subscription.metadata[featureKey]) {
      return subscription.metadata[featureKey] === 'true';
    }

    // No explicit feature access defined
    return false;
  } catch (error) {
    // NC3 fix: re-throw infrastructure errors so callers know the check failed.
    // Silently returning false would grant no access on a Firestore outage, but
    // it also hides outages completely — callers deserve to know the difference.
    throw handleError(error, {
      userMessage: 'Failed to check feature access',
      severity: 'error',
      context: { function: 'hasFeatureAccess', userId, featureKey },
    });
  }
}

/**
 * Options for verifying and handling a Stripe webhook request.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export interface StripeWebhookOptions extends SubscriptionOptions {
  /** Raw request body as string or Buffer (required for HMAC verification) */
  rawBody: string | Buffer;
  /** Value of the Stripe-Signature header */
  signature: string;
  /** Stripe webhook endpoint secret (whsec_...) */
  webhookSecret: string;
}

/**
 * Verifies the Stripe webhook HMAC signature and handles the event.
 *
 * NC2 fix: previously handleStripeWebhookEvent accepted a pre-parsed event with no
 * signature verification — any caller could forge arbitrary Stripe events.
 * This function must be used instead: it calls stripe.webhooks.constructEvent()
 * before processing the payload.
 *
 * @param options - Webhook options including rawBody, signature, and webhookSecret
 * @returns The verified Stripe event type that was processed
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function verifyAndHandleStripeWebhook(
  options: StripeWebhookOptions
): Promise<void> {
  const { rawBody, signature, webhookSecret, ...subscriptionOptions } = options;

  // Stripe SDK is dynamically imported to keep it optional — no compile-time types available
  let stripe: any; // Stripe instance type varies across SDK versions; dynamic import prevents static typing
  try {
    const stripeModule = await import('stripe');
    const StripeClass = stripeModule.default ?? stripeModule;
    // 'placeholder' is safe here: constructEvent() only performs HMAC signature
    // verification using webhookSecret, never makes API calls with this key.
    stripe = new StripeClass('placeholder', {
      apiVersion: '2023-10-16' as any,
    }); // Stripe SDK apiVersion is a branded string literal that changes per SDK version
  } catch {
    throw handleError(new Error('stripe package is not installed'), {
      userMessage: 'Stripe package missing — cannot verify webhook signature',
      severity: 'error',
    });
  }

  let event: any; // Stripe.Event type unavailable — stripe is dynamically imported (see above)
  try {
    // NC2 fix: this throws if the signature is invalid — forgery is rejected here
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (error) {
    throw handleError(error, {
      userMessage: 'Stripe webhook signature verification failed',
      severity: 'error',
      context: { function: 'verifyAndHandleStripeWebhook' },
    });
  }

  await handleStripeWebhookEvent(event, subscriptionOptions);
}

/**
 * @internal Not part of the public API — use `verifyAndHandleStripeWebhook` instead.
 *
 * Handler for Stripe webhook events.
 *
 * **Important:** Prefer {@link verifyAndHandleStripeWebhook} which validates the
 * HMAC signature before processing. Only call this directly if you have already
 * verified the event via stripe.webhooks.constructEvent().
 *
 * @param event Stripe event object (must be HMAC-verified before calling)
 * @param options Operation options
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
async function handleStripeWebhookEvent(
  event: StripeEventObject,
  options: SubscriptionOptions = {}
): Promise<void> {
  const eventType = event.type;
  const data = event.data.object;

  try {
    switch (eventType) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await saveSubscriptionFromStripeEvent(data, options);
        break;

      case 'customer.subscription.deleted':
        await updateSubscriptionStatus(data.id, 'canceled', options);
        break;

      // Handle other event types as needed

      default:
      // Ignore unhandled event types
    }
  } catch (error) {
    throw handleError(error, {
      userMessage: `Failed to handle Stripe webhook event: ${eventType}`,
      severity: 'error',
      context: {
        eventType,
        eventId: event.id,
      },
    });
  }
}

/**
 * Converts a Stripe subscription object to SubscriptionData
 * @param stripeSubscription Stripe subscription object
 * @param options Operation options
 */
async function saveSubscriptionFromStripeEvent(
  stripeSubscription: StripeSubscriptionObject,
  options: SubscriptionOptions = {}
): Promise<void> {
  // Guard: a subscription with zero items is invalid and cannot be processed
  if (!stripeSubscription.items.data.length) {
    throw handleError(
      new Error('[subscription] Stripe subscription has no items'),
      {
        userMessage: 'Stripe subscription has no items — cannot determine plan',
        severity: 'error',
        context: { subscriptionId: stripeSubscription.id },
      }
    );
  }

  // Extract subscription data from Stripe object
  const subscription: SubscriptionData = {
    id: stripeSubscription.id,
    customerId: stripeSubscription.customer,
    status: stripeSubscription.status as SubscriptionStatus,
    planId: stripeSubscription.items.data[0]?.plan.id || '',
    currentPeriodStart: new Date(
      stripeSubscription.current_period_start * 1000
    ).toISOString(),
    currentPeriodEnd: new Date(
      stripeSubscription.current_period_end * 1000
    ).toISOString(),
    cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end,
    metadata: stripeSubscription.metadata || {},
    createdAt: new Date(stripeSubscription.created * 1000).toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Add canceledAt if present
  if (stripeSubscription.canceled_at) {
    subscription.canceledAt = new Date(
      stripeSubscription.canceled_at * 1000
    ).toISOString();
  }

  // Save subscription to Firestore
  await saveSubscription(subscription, options);
}
