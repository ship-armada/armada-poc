/**
 * Browser Database Setup for Railgun Wallet SDK
 *
 * Uses level-js (IndexedDB-backed) for browser-compatible storage.
 * See: https://docs.railgun.org/developer-guide/wallet/getting-started/3.-set-up-database
 */

// @ts-expect-error - level-js doesn't have proper types
import LevelDB from 'level-js';

/**
 * Creates a new web database instance at the specified location path
 * @param dbLocationPath - The IndexedDB database name
 * @returns A new LevelDB database instance
 */
export const createWebDatabase = (dbLocationPath: string) => {
  console.log('[railgun] Creating local database at path:', dbLocationPath);
  const db = new LevelDB(dbLocationPath);
  return db;
};
