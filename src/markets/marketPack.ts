import type { Market } from "./market";
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

export type LookSpecLexicon = Record<string, unknown>;

export interface MarketPack {
  market: Market;
  defaultLocale: string;
  commerceEnabled: boolean;
  getLookSpecLexicon(): LookSpecLexicon;
  loadTechniqueKB(): TechniqueKB;
  getPromptPack(locale: string): PromptPack;
}

