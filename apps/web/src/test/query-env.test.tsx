/**
 * Environment regression test: React Query (jsdom AbortSignal) + undici fetch + MSW
 * must interoperate — guarded by the signal bridge in setup.ts.
 */
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";

function Probe() {
  const q = useQuery({
    queryKey: ["probe"],
    queryFn: async ({ signal }) => {
      const res = await fetch("https://api.openstreetmap.org/api/0.6/node/101.json", { signal });
      const body = (await res.json()) as { elements: { tags: { name: string } }[] };
      return body.elements[0]?.tags.name ?? "none";
    },
  });
  if (q.isPending) return <div>pending</div>;
  if (q.isError) return <div>error: {String(q.error)}</div>;
  return <div>name: {q.data}</div>;
}

test("react-query + msw json roundtrip works in the test environment", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
  const el = await screen.findByText(/name:|error:/, {}, { timeout: 3000 });
  expect(el.textContent).toBe("name: Café Central");
});
