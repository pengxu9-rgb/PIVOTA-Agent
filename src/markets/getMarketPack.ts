import { Market } from "./market";

import type { TechniqueCardV0 } from "../layer2/schemas/techniqueCardV0";

export type TechniqueKB = {
  byId: Map<string, TechniqueCardV0>;
  list: TechniqueCardV0[];
};

export type PromptPack = {
  lookSpecExtract: string;
  adjustmentsRephrase: string;
  stepsGenerate: string;
};

export interface MarketPack {
  market: Market;
  defaultLocale: string;
  commerceEnabled: boolean;
  getLookSpecLexicon: () => unknown;
  loadTechniqueKB: () => TechniqueKB;
  getPromptPack: (locale: string) => PromptPack;
}

export type GetMarketPackInput = {
  market: Market;
  locale?: string;
};

export declare function getMarketPack(input: GetMarketPackInput): MarketPack;

