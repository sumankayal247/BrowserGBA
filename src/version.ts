/**
 * Application identity. Keep the storage schema version here so that migrations
 * and backup manifests agree on a single source of truth.
 */
export const APP_NAME = 'BrowserGBA';
export const APP_VERSION = '0.1.0';

/**
 * IndexedDB schema version. Bump this *and* append a step to the `migrations`
 * list in `src/storage/db.ts` whenever a store or index changes: existing
 * libraries are upgraded in place, never dropped.
 */
export const DB_SCHEMA_VERSION = 2;

/** Version stamped into exported backup packages. */
export const BACKUP_FORMAT_VERSION = 1;
