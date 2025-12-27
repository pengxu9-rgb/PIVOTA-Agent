import type { TechniqueKB } from "./loadTechniqueKB";
import { loadTechniqueKB } from "./loadTechniqueKB";

export type TechniqueKBUS = {
  byId: TechniqueKB["byId"];
  list: TechniqueKB["list"];
};

export function loadTechniqueKBUS(): TechniqueKBUS {
  return loadTechniqueKB("US");
}
