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

  const cwd = process.cwd();
  const normalized = cwd.replace(/\\/g, '/');

  // Next.js standalone server sets cwd to ".next/standalone".
  // Persist data outside build output so redeploy/build does not wipe runtime state.
  if (normalized.endsWith('/.next/standalone')) {
    return path.resolve(cwd, '..', '..', 'data');
  }

  return path.join(cwd, 'data');
}
