/**
 * Backup reminders (book/src/roadmap.md Phase 6: persistent-storage prompts,
 * backup reminders): data is device-local; a library without a recent backup
 * deserves a nudge, never a nag.
 */
const KEY = "placemarks:lastBackupAt";
export const BACKUP_REMINDER_DAYS = 30;

export function recordBackup(now: string, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(KEY, now);
  } catch {
    // Storage unavailable — the reminder will simply stay visible.
  }
}

export function lastBackupAt(storage: Pick<Storage, "getItem"> = localStorage): string | undefined {
  try {
    return storage.getItem(KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Remind when the library has content and no backup exists within the window. */
export function shouldRemindBackup(
  placeCount: number,
  now: string,
  storage: Pick<Storage, "getItem"> = localStorage,
): boolean {
  if (placeCount === 0) return false;
  const last = lastBackupAt(storage);
  // Absent or unparseable metadata means no usable backup — remind.
  if (!last || !Number.isFinite(Date.parse(last))) return true;
  const elapsed = Date.parse(now) - Date.parse(last);
  return elapsed > BACKUP_REMINDER_DAYS * 24 * 60 * 60 * 1000;
}
