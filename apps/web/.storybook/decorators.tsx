import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Decorator } from "@storybook/react";

/** Fresh QueryClient per story so cached data never leaks between stories/tests. */
export const withProviders: Decorator = (Story) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <Story />
    </QueryClientProvider>
  );
};
