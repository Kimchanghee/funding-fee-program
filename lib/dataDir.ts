import path from 'path';

/**
 * Shared server-side data directory.
 * Priority:
 * 1) FUNDING_FEE_DATA_DIR env
 * 2) process cwd ./data
 */
export function getDataDir(): string {
  const configured = process.env.FUNDING_FEE_DATA_DIR?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(process.cwd(), 'data');
}

