/**
 * Runs every Storybook story — including its play() assertions — headless in vitest.
 * The same stories are the human inspection surface in `pnpm storybook`.
 * MSW is served by the node server from test/setup.ts (same handlers as the browser).
 */
import { composeStories, setProjectAnnotations } from "@storybook/react";
import { act, render } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, test } from "vitest";
import { withProviders } from "../../.storybook/decorators";
import * as NewListFormStories from "../features/lists/NewListForm.stories";
import * as NoteEditorStories from "../features/notes/NoteEditor.stories";
import * as CandidatePickerStories from "../features/picker/CandidatePicker.stories";
import * as ManualPinDialogStories from "../features/picker/ManualPinDialog.stories";
import * as PlaceDetailsSheetStories from "../features/place/PlaceDetailsSheet.stories";
import * as PlaceFieldsStories from "../features/place/PlaceFields.stories";
import * as PlaceSheetStories from "../features/place/PlaceSheet.stories";
import * as StateBadgeStories from "../features/place/StateBadge.stories";
import * as TagEditorStories from "../features/place/TagEditor.stories";
import * as SearchBarStories from "../features/search/SearchBar.stories";
import * as MarkdownStories from "../markdown/Markdown.stories";

setProjectAnnotations([{ decorators: [withProviders] }]);

const modules = [
  ["StateBadge", StateBadgeStories],
  ["PlaceFields", PlaceFieldsStories],
  ["PlaceSheet", PlaceSheetStories],
  ["PlaceDetailsSheet", PlaceDetailsSheetStories],
  ["SearchBar", SearchBarStories],
  ["CandidatePicker", CandidatePickerStories],
  ["ManualPinDialog", ManualPinDialogStories],
  ["TagEditor", TagEditorStories],
  ["NewListForm", NewListFormStories],
  ["NoteEditor", NoteEditorStories],
  ["Markdown", MarkdownStories],
] as const;

type RunnableStory = React.ComponentType & {
  play?: (context: { canvasElement: HTMLElement }) => Promise<void> | void;
};

for (const [name, module] of modules) {
  describe(`stories/${name}`, () => {
    const composed = composeStories(module as never) as unknown as Record<string, RunnableStory>;
    for (const [storyName, Story] of Object.entries(composed)) {
      test(storyName, async () => {
        // Meta-level fn() spies are shared across a file's stories — reset them so
        // one story's interactions never leak into another's assertions.
        const args = (Story as unknown as { args?: Record<string, unknown> }).args ?? {};
        for (const value of Object.values(args)) {
          if (typeof value === "function" && "mockClear" in value) {
            (value as { mockClear: () => void }).mockClear();
          }
        }
        const { container } = await act(async () => render(<Story />));
        await Story.play?.({ canvasElement: container });
        // Continuous accessibility (spec/src/roadmap.md Phase 9 (hardening, formerly Phase 6)): serious and
        // critical axe violations fail the story, every run, not in an audit.
        const a11y = await axe.run(container, {
          rules: { "color-contrast": { enabled: false } }, // jsdom cannot compute styles reliably
        });
        const blocking = a11y.violations.filter(
          (violation) => violation.impact === "serious" || violation.impact === "critical",
        );
        expect(blocking.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
      });
    }
  });
}
