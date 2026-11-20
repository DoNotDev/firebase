// packages/providers/firebase/src/public/index.ts

/**
 * @fileoverview Firebase public server reader exports
 * @description `@donotdev/firebase/public`: anonymous Firestore reads on the server
 * (Web SDK, no auth instance, no Admin SDK, no service account), checked by Security
 * Rules. Imported by the Next files the framework generates (sitemap, llms.txt, entity
 * pages' `generateStaticParams`). Loads neither the client auth bootstrap nor
 * firebase-admin (`@donotdev/firebase/server`).
 *
 * @version 0.1.0
 * @since 0.3.1
 * @author AMBROISE PARK Consulting
 */

export {
  createPublicServerFirestore,
  type PublicFirestoreConfig,
} from './publicFirestore';
export { FirestorePublicReader } from './FirestorePublicReader';
