import type { PlacemarksRepository } from "@placemarks/domain";
import { createContext, useContext } from "react";
import { DexieRepository } from "./repo";

let defaultRepo: DexieRepository | undefined;

/** Lazy singleton so importing this module never opens IndexedDB eagerly (tests). */
export function getDefaultRepo(): DexieRepository {
  defaultRepo ??= new DexieRepository();
  return defaultRepo;
}

const RepoContext = createContext<PlacemarksRepository | undefined>(undefined);

export function RepoProvider({
  repo,
  children,
}: {
  repo: PlacemarksRepository;
  children?: React.ReactNode;
}) {
  return <RepoContext.Provider value={repo}>{children}</RepoContext.Provider>;
}

export function useRepo(): PlacemarksRepository {
  const repo = useContext(RepoContext);
  if (!repo) throw new Error("RepoProvider missing");
  return repo;
}

/**
 * The concrete Dexie repository — for surfaces that need beyond-the-port state
 * (backup archives, the import review queue). Falls back to the default
 * singleton when the provided repository is a test double without a db.
 */
export function useDexieRepo(): DexieRepository {
  const repo = useRepo();
  return (repo as DexieRepository).db ? (repo as DexieRepository) : getDefaultRepo();
}
