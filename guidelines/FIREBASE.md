# Firebase

**From zero to deployed in 5 steps. Covers Auth, Firestore, Storage, Cloud Functions, and Hosting.**

---

## Step 1: Run Coach + Fill .env

```bash
dndev coach
```

This prints a numbered checklist of what to configure. For Firebase, you'll need:
- **SDK config** (API key, project ID, auth domain, etc.) - paste into your app's `.env`
- **Service account key** - download and save as `service-account-key.json`
- **Enable services** (Auth, Firestore, Storage) in Firebase Console

Then run setup to validate and automate:

```bash
dndev setup
```

Setup validates .env values, checks Firebase CLI, selects/creates a web app, updates `.firebaserc` and `firebase.json`.

**After running, it will prompt you for 2 manual steps (below).**

---

## Step 2: Download Service Account Key

The CLI gives you a direct link. In short:

1. Firebase Console > Project Settings > Service Accounts
2. Click "Generate new private key"
3. Save the file as `service-account-key.json` in your app root
4. This file is `.gitignored` - never commit it

**Why?** The service account key authenticates `dndev deploy` and Cloud Functions to your Firebase project. Without it, deployment fails.

---

## Step 3: Enable Firebase Services

Go to the Firebase Console and enable:

**Authentication** (required):
- Get Started > Enable Email/Password
- Add OAuth providers if needed (Google, GitHub, etc.)

**Cloud Firestore** (required):
- Create Database > Start in test mode > Select region (e.g., europe-west1)
- Test mode rules expire after 30 days - Phase 4 generates proper rules

**Storage** (optional - only if your app uploads files):
- Get Started > Select region

---

## Step 4: Test Locally

```bash
dndev emu start
```

Select services: Auth + Firestore + Functions. This starts Firebase emulators so you can develop without touching production.

**Verify:** Open the app (`dndev dev`), sign up, create some data. Everything runs locally.

---

## Step 5: Deploy

```bash
dndev deploy
```

This handles everything:
- Builds the app
- Deploys hosting (your frontend)
- Deploys Cloud Functions (your backend)
- Configures Cloud Run IAM automatically (fixes CORS preflight on 2nd gen functions)
- Deploys Firestore rules (if `firestore.rules` exists)

**After deploy:** Your app is live at `https://<project-id>.web.app`.

---

## Cloud Functions

Functions are scaffolded in `functions/` and auto-deployed with `dndev deploy`.

**Server secrets** (Stripe, OAuth, etc.) go in `functions/.env` - see the [Secrets](#secrets-stripe-oauth-etc) section below.

### CRUD Functions (one line)

```typescript
// functions/src/index.ts
import { initializeApp } from 'firebase-admin/app';
import { createCrudFunctions } from '@donotdev/functions/firebase';
import * as entities from 'entities';

initializeApp();
export const crud = createCrudFunctions(entities);
```

**Result:** Auto-generates CRUD handlers for each entity. The export name (camelCase, e.g. `crud`) is what you use client-side: `httpsCallable(functions, 'crud')`. The operation ID (snake_case, e.g. `create_products`) is used internally for logging and rate limiting.

### Bulk

Every entity registered via `createCrudFunctions` also gets a `bulk_${collection}` handler — transactional multi-row CRUD for the one-submit-many-rows case (setup wizards, spreadsheet-style editors, batch deletes).

```typescript
// Client — via FunctionsAdapter
await crud.bulk({
  inserts: [{ name: 'Alpha' }, { name: 'Beta' }],
  updates: [{ id: 'abc', patch: { name: 'Updated' } }],
  deletes: ['xyz'],
});
// → { insertedIds, updatedIds, deletedIds } — input order preserved.
```

**Atomicity contract:**

- **One Firestore transaction** — every insert, update, and delete is issued inside a single `runTransaction`. Any failure rolls the entire batch back; partial state is impossible.
- **One audit entry** — `crud.bulk.${collection}` with counts (`{ inserts, updates, deletes }`), never row ids. Anomaly detection fires on the bulk count.
- **One rate-limit hit** — checked at function entry, not per op.
- **Up-front rejection** — collisions (same id in `updates`+`deletes` or `inserts`+`updates`) and schema validation errors reject *before* the transaction opens. `BulkCollisionError` is raised as `permission-denied` / `invalid-argument` via the standard error classifier.
- **Empty bulk is a no-op** — `bulk({})` returns zeroed arrays without hitting Firestore.

### Custom Functions

```typescript
import * as v from 'valibot';
import { createFunction } from '@donotdev/functions/firebase';
import { getFirebaseAdminFirestore } from '@donotdev/firebase/server';

const schema = v.object({ productId: v.string() });

export const getProductDetails = createFunction(schema, 'get_product_details', async (data, { uid }) => {
  const db = getFirebaseAdminFirestore();
  const doc = await db.collection('products').doc(data.productId).get();
  return doc.data();
});
```

Rate limiting, metrics, auth, schema validation - all included by default.

### Import Rules

**Functions run on Node.js - you MUST use `/server` imports:**

```typescript
// CORRECT
import { getFirebaseAdminFirestore } from '@donotdev/firebase/server';
import { handleError } from '@donotdev/core/server';

// WRONG - crashes on deploy
import { getFirestore } from '@donotdev/firebase';
import { handleError } from '@donotdev/core';
```

### Cloud Run IAM (Technical Detail)

Firebase 2nd gen Cloud Functions run on Cloud Run. By default, Cloud Run blocks unauthenticated OPTIONS requests (CORS preflight). `dndev deploy` automatically runs `gcloud run services update --no-invoker-iam-check` on all deployed functions.

If you deploy manually with `firebase deploy`, you'll see `403 Forbidden` on CORS preflight. Use `dndev deploy` instead.

---

## Environment Variables

**Vite loads `.env` from the app directory only. NOT from the repo root.**

| File | What Goes Here | Loaded By |
|------|---------------|-----------|
| `apps/<app>/.env` | Firebase config, Stripe publishable key | Vite (at dev + build) |
| `apps/<app>/.env.local` | Local overrides (gitignored) | Vite (overrides .env) |
| `apps/<app>/.env.production` | Production overrides | Vite (at build --mode production) |
| `apps/<app>/.env.staging` | Staging config | Vite (via `dndev staging`) |
| `functions/.env` | Server secrets: STRIPE_SECRET_KEY, OAuth secrets | Cloud Functions runtime |
| Root `.env` | **Not read by Vite.** Reference only. | Nothing |

**`dndev setup` writes Firebase vars to the app's `.env` automatically.**

**Custom domains:** Framework uses `APP_URL` hostname as `authDomain` in production (not Firebase's `projectId.firebaseapp.com`). Set your `FIREBASE_AUTH_DOMAIN` env var (with the appropriate `VITE_` or `NEXT_PUBLIC_` prefix) in `.env.local` and `.env.production` - framework handles the rest.

---

## Staging Environment (Optional)

1. Create a second Firebase project (e.g., `my-app-staging`)
2. Run `dndev setup firebase` to configure the staging project
3. The wizard updates `.firebaserc` - add a `"staging"` alias manually if the wizard only sets `"default"`:
   ```json
   { "projects": { "default": "my-app-prod", "staging": "my-app-staging" } }
   ```
4. Create `service-account-key.staging.json` (same steps as production)
5. Deploy: `dndev staging`

---

## Secrets (Stripe, OAuth, etc.)

Server-side secrets go in `functions/.env`, not the app `.env`.

**We NEVER ask for secret keys.** You place them yourself:

```bash
# functions/.env
STRIPE_SECRET_KEY=<stripe_secret_key>
STRIPE_WEBHOOK_SECRET=whsec_...
GITHUB_CLIENT_SECRET=...
```

Then sync to your runtime and CI/CD:

```bash
dndev sync-secrets                    # Firebase Secret Manager
dndev sync-secrets --target github    # GitHub Secrets (for CI/CD workflows)
```

Secrets are auto-loaded by Cloud Functions at runtime. Never put server secrets in `VITE_*` variables - those are exposed to the browser.

---

## Troubleshooting

**"Service account key not found"**
- Download from Firebase Console > Service Accounts > Generate new private key
- Save as `service-account-key.json` in your app root

**"Permission denied" / 401 on deploy**
- Check service account key is valid JSON with `project_id`, `private_key`, `client_email`
- Re-download if corrupted

**"CORS error" on function calls**
- Use `dndev deploy` instead of `firebase deploy` (handles IAM automatically)
- Or run: `gcloud run services update <function-name> --region=<region> --no-invoker-iam-check --project=<project-id>`

**".env values not loading"**
- Check the `.env` file is in your **app directory** (`apps/<app>/.env`), not the repo root
- All Vite vars must start with `VITE_`

- Must start with `dndev_` and be at least 20 characters

---

**`dndev coach` > fill .env > `dndev setup` > download service account key > enable Auth + Firestore > `dndev emu start` > `dndev deploy`. That's it.**
