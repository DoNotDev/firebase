# Gotchas: @donotdev/providers

Common mistakes related to Firebase and Supabase provider integration.

---

## Provider Imports [Phase 1, 2, 3]

**Server code MUST use `/server` imports - client imports crash on deploy.**

```typescript
// CORRECT
import { getFirebaseAdminFirestore } from '@donotdev/firebase/server';

// WRONG - crashes on deploy
import { getFirestore } from '@donotdev/firebase';
```

---

## Deployment [Phase 4]

**Deploy with `dndev deploy`** - not `firebase deploy`. Manual deploy causes CORS 403 on preflight because Cloud Run blocks unauthenticated OPTIONS by default.

---

## Environment Variables [Phase 1]

- Client: `apps/my-app/.env` (prefix with `VITE_*`)
- Server: `functions/.env` (secrets: `STRIPE_*`, OAuth tokens)
- Local overrides: `.env.local` (gitignored)

**Supabase RLS must be enabled** in SQL migrations (`ENABLE ROW LEVEL SECURITY`) for SOC2 CC6.3 compliance.

**Firestore default-deny** rules (`allow read, write: if false`) must be the base before adding specific allow rules.
