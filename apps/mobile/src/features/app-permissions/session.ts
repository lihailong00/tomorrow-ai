import { inspectAppPermissions, openDeviceSettings, type DeviceAction, type PermissionFinding, type PermissionQuery, type PermissionReport } from './inspection';

const contextLifetimeMs = 10 * 60 * 1000;

/** One navigation entry owns these device-only details. Never serialize them. */
export function createPermissionSession() {
  let lastCheckedAt: number | undefined;
  let selection: { finding: PermissionFinding; selectedAt: number; comparable: boolean } | undefined;
  const isRecent = (at?: number) => at !== undefined && Date.now() - at < contextLifetimeMs;
  const selected = () => selection && isRecent(selection.selectedAt) ? selection : undefined;
  return {
    hasRecentCheck: () => isRecent(lastCheckedAt),
    selected,
    select(finding: PermissionFinding, source: PermissionReport) {
      selection = { finding, selectedAt: Date.now(), comparable: source.unavailable.length === 0 };
    },
    remember(value: PermissionReport) {
      lastCheckedAt = value.checkedAt;
      const previous = selected();
      const finding = previous && value.findings.find(item => item.packageName === previous.finding.packageName);
      if (finding) selection = { finding, selectedAt: Date.now(), comparable: value.unavailable.length === 0 };
    },
    clear() { lastCheckedAt = undefined; selection = undefined; },
    async check(query: PermissionQuery): Promise<PermissionReport | undefined> {
      const previous = query.scope === 'selected_app' ? selected() : undefined;
      if (query.scope === 'selected_app' && !previous) return;
      const scanned = await inspectAppPermissions(query.permission, previous?.finding.packageName);
      if (!scanned) return;
      const next = scanned.findings.find(item => item.packageName === previous?.finding.packageName);
      const changes = previous?.comparable && next && scanned.unavailable.length === 0 ? {
        added: next.grants.filter(grant => !previous.finding.grants.includes(grant)),
        removed: previous.finding.grants.filter(grant => !next.grants.includes(grant)),
      } : {};
      return { ...scanned, inspection: query.inspection, permission: query.permission, scope: query.scope, ...changes, checkedAt: Date.now() };
    },
  };
}

export type PermissionSession = ReturnType<typeof createPermissionSession>;
export type DeviceResult = { report?: PermissionReport; settings?: 'requested' | 'system_settings' };

export async function performDeviceAction(session: PermissionSession, action: DeviceAction): Promise<DeviceResult> {
  if (action.kind === 'system_settings') {
    const selection = session.selected();
    if (action.destination === 'selected_app' && !selection) return {};
    return { settings: await openDeviceSettings(action.destination, action.destination === 'selected_app' ? selection?.finding.packageName : undefined) };
  }
  return { report: await session.check(action) };
}
