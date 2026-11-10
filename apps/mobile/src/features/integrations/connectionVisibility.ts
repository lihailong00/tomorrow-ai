type ConnectionState = { status: string; has_credentials?: boolean };

/** Existing grants remain manageable even if new connections are disabled. */
export function hasSavedConnection(item: ConnectionState): boolean {
  return Boolean(item.has_credentials || ['connected', 'needs_reconnect', 'reconnect_required'].includes(item.status));
}

/** Missing catalogs and disabled services must not become advertised choices. */
export function isConnectionVisible(item: ConnectionState): boolean {
  return item.status !== 'not_configured' || hasSavedConnection(item);
}
