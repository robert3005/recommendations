import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import { CandidatePicker } from "./CandidatePicker";

const meta = {
  title: "Picker/CandidatePicker",
  component: CandidatePicker,
  args: {
    title: "Mercado da Ribeira",
    candidates: [
      {
        name: "Mercado da Ribeira",
        lat: 38.7071,
        lng: -9.1461,
        address: "Av. 24 de Julho, Lisboa",
        osmRef: { type: "way", id: "1" },
      },
      {
        name: "Time Out Market",
        lat: 38.707,
        lng: -9.1458,
        osmRef: { type: "node", id: "2" },
      },
    ],
    origin: { lat: 38.7072, lng: -9.146 },
    onPick: fn(),
    onSkip: fn(),
    onClose: fn(),
  },
} satisfies Meta<typeof CandidatePicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LetteredCandidates: Story = {};

export const NothingMatched: Story = {
  args: { candidates: [] },
};
