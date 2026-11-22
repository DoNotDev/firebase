# @donotdev/firebase

## Unreleased

### Patch Changes

- Declares `stripe` as an optional peer dependency (`verifyAndHandleStripeWebhook` imports it lazily). It was undeclared and resolved only through monorepo hoisting, so a bundler outside the monorepo could fail on the import. Apps with Stripe billing install `stripe`; the scaffolded functions templates already do.
- `FirestorePublicReader.query` returns documents as stored whatever schema it is given: the framework's record readers now pass the entity's read schema (field names, which Firestore documents already use), and validating against it would strip fields and fail the sitemap on a document the schema rejects.

## 0.1.43

### Patch Changes

- a4c57d7: bugfixes and performance upgrades
- Updated dependencies [98d641c]
- Updated dependencies [a4c57d7]
- Updated dependencies [2b8210a]
  - @donotdev/core@0.1.43
  - @donotdev/components@0.1.44
