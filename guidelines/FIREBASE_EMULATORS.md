# Firebase Emulators

Local development environment setup for the Firebase Emulator Suite.

## Environment Variables

The framework uses a strict separation between local development and production secrets for functions.

### Local Development (.env.local)

**`functions/.env.local` is the exclusive source of truth for emulators.**

When you run `dndev emu <app-name>`, the framework loads environment variables **ONLY** from `functions/.env.local`.

1. Create `functions/.env.local` (it is git-ignored by default).
2. Add your local development keys (e.g., Stripe ephemeral webhook secret).

```bash
# functions/.env.local
STRIPE_SECRET_KEY=<stripe_secret_key>
STRIPE_WEBHOOK_SECRET=whsec_... # Get this from 'stripe listen' output
```

### Production Secrets (.env)

**`functions/.env` is the source of truth for production secrets.**

These are the secrets that will be synced to Firebase Cloud Functions when you run `dndev deploy` or `dndev sync-secrets`.

```bash
# functions/.env
STRIPE_SECRET_KEY=<stripe_secret_key>
STRIPE_WEBHOOK_SECRET=whsec_... # Your permanent production webhook secret
```

## Running the Emulator

```bash
# Start emulators for a specific app
dndev emu showcase
```

If you need Stripe webhook forwarding, the emulator command will provide instructions on how to start the Stripe CLI and where to paste the temporary webhook secret.

## Troubleshooting

1. **Signature Verification Error**: This usually means the `STRIPE_WEBHOOK_SECRET` in your `functions/.env.local` does not match the secret displayed in your active `stripe listen` terminal.
2. **Missing Secrets**: Ensure you have created the `functions/.env.local` file. The emulator command will warn you if it's missing.
