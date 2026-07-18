import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Decorator } from "@storybook/react";
import { RepoProvider } from "../src/data/RepoContext";
import { DexieRepository } from "../src/data/repo";

let activeRepo: DexieRepository | undefined;
let dbCounter = 0;

/** The repository the current story is rendered against (fresh per story). */
export function getActiveRepo(): DexieRepository {
  if (!activeRepo) throw new Error("no active story repo");
  return activeRepo;
}

/**
 * Fresh QueryClient + fresh isolated repository per story so no state leaks
 * between stories/tests (real IndexedDB in the Storybook browser, fake in vitest).
 */
export const withProviders: Decorator = (Story) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  dbCounter += 1;
  activeRepo = new DexieRepository(`story-${dbCounter}-${Math.random().toString(36).slice(2, 8)}`);
  return (
    <QueryClientProvider client={client}>
      <RepoProvider repo={activeRepo}>
        <Story />
      </RepoProvider>
    </QueryClientProvider>
  );
};
