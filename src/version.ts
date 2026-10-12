/**
 * Application identity. Keep the storage schema version here so that migrations
 * and backup manifests agree on a single source of truth.
 */
export const APP_NAME = 'BrowserGBA';
export const APP_VERSION = '0.1.0';

/**
 * IndexedDB schema version. Bump this *and* add a migration step in
 * `src/storage/migrations.ts` whenever a store or index changes.
 */
export const DB_SCHEMA_VERSION = 1;

/** Version stamped into exported backup packages. */
export const BACKUP_FORMAT_VERSION = 1;
