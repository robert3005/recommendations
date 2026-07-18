/**
 * Runs every Storybook story — including its play() assertions — headless in vitest.
 * The same stories are the human inspection surface in `pnpm storybook`.
 * MSW is served by the node server from test/setup.ts (same handlers as the browser).
 */
import { composeStories, setProjectAnnotations } from "@storybook/react";
import { act, render } from "@testing-library/react";
import { describe, test } from "vitest";
import { withProviders } from "../../.storybook/decorators";
import * as CandidatePickerStories from "../features/picker/CandidatePicker.stories";
import * as PlaceFieldsStories from "../features/place/PlaceFields.stories";
import * as PlaceSheetStories from "../features/place/PlaceSheet.stories";
import * as StateBadgeStories from "../features/place/StateBadge.stories";
import * as SearchBarStories from "../features/search/SearchBar.stories";

setProjectAnnotations([{ decorators: [withProviders] }]);

const modules = [
  ["StateBadge", StateBadgeStories],
  ["PlaceFields", PlaceFieldsStories],
  ["PlaceSheet", PlaceSheetStories],
  ["SearchBar", SearchBarStories],
  ["CandidatePicker", CandidatePickerStories],
] as const;

type RunnableStory = React.ComponentType & {
  play?: (context: { canvasElement: HTMLElement }) => Promise<void> | void;
};

for (const [name, module] of modules) {
  describe(`stories/${name}`, () => {
    const composed = composeStories(module as never) as unknown as Record<string, RunnableStory>;
    for (const [storyName, Story] of Object.entries(composed)) {
      test(storyName, async () => {
        const { container } = await act(async () => render(<Story />));
        await Story.play?.({ canvasElement: container });
      });
    }
  });
}
