/** Settings: backup export/import, storage persistence, licensing (Phase 2). */
import { useRef, useState } from "react";
import { getDefaultRepo, useRepo } from "../../data/RepoContext";
import type { DexieRepository } from "../../data/repo";
import { nowIso } from "../../lib/time";
import { exportBackup, importBackup } from "./backup";

export function SettingsPage() {
  const repo = useRepo();
  const fileRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"replace" | "merge">("merge");
  const [message, setMessage] = useState<string>();

  const dexieRepo = (repo as DexieRepository).db ? (repo as DexieRepository) : getDefaultRepo();

  const doExport = async () => {
    const blob = await exportBackup(dexieRepo, nowIso());
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `placemarks-backup-${new Date().toISOString().slice(0, 10)}.zip`;
    a.click();
    URL.revokeObjectURL(url);
    setMessage("Backup exported.");
  };

  const doImport = async (file: File) => {
    try {
      const result = await importBackup(dexieRepo, file, mode, nowIso());
      setMessage(
        `Imported ${result.imported} records (${result.mode})${
          result.conflictCopies > 0 ? `, ${result.conflictCopies} note conflict copies kept` : ""
        }.`,
      );
    } catch (err) {
      setMessage(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const requestPersistence = async () => {
    const granted = navigator.storage?.persist ? await navigator.storage.persist() : false;
    setMessage(
      granted
        ? "Persistent storage granted — the browser won't evict your data under pressure."
        : "Persistent storage was not granted; export backups regularly.",
    );
  };

  return (
    <div className="mx-auto max-w-2xl p-4" data-testid="settings-page">
      <h1 className="text-xl font-semibold text-stone-900">Settings</h1>

      <section className="mt-4">
        <h2 className="text-sm font-semibold text-stone-700">Backup</h2>
        <p className="mt-1 text-xs text-stone-500">
          A versioned ZIP with your places, tags, notes, guides, media, and the OSM evidence
          needed to preserve place identity. Data is device-local — back up regularly.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void doExport()}
            className="rounded bg-stone-800 px-3 py-1.5 text-sm font-medium text-white"
            data-testid="export-backup"
          >
            Export backup
          </button>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="rounded border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700"
            data-testid="import-backup"
          >
            Import backup…
          </button>
          <label className="flex items-center gap-1 text-xs text-stone-600">
            <input
              type="radio"
              name="import-mode"
              checked={mode === "merge"}
              onChange={() => setMode("merge")}
            />
            Merge
          </label>
          <label className="flex items-center gap-1 text-xs text-stone-600">
            <input
              type="radio"
              name="import-mode"
              checked={mode === "replace"}
              onChange={() => setMode("replace")}
            />
            Replace everything
          </label>
          <input
            ref={fileRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            aria-label="Backup file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void doImport(file);
              e.target.value = "";
            }}
          />
        </div>
      </section>

      <section className="mt-6">
        <h2 className="text-sm font-semibold text-stone-700">Storage</h2>
        <button
          type="button"
          onClick={() => void requestPersistence()}
          className="mt-2 rounded border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700"
        >
          Request persistent storage
        </button>
      </section>

      {message ? (
        <p className="mt-4 rounded bg-stone-100 p-2 text-sm text-stone-700" data-testid="settings-message">
          {message}
        </p>
      ) : null}

      <section className="mt-6 text-xs text-stone-500">
        <h2 className="text-sm font-semibold text-stone-700">Data sources</h2>
        <p className="mt-1">
          Map and place data © OpenStreetMap contributors, ODbL. Corrections to public place
          facts belong upstream on openstreetmap.org.
        </p>
      </section>
    </div>
  );
}
