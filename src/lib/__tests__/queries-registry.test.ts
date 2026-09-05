import { describe, it, expect } from "vitest";
import { QUERY_ENTITIES, entityTypesForModule } from "@/lib/queries/registry";
import { QUERY_MODULE_LABELS, type QueryModule } from "@/lib/queries/types";

/**
 * entityTypesForModule backs the /queries module chip's SQL-level filter
 * (see src/app/api/queries/route.ts) — it has to agree with every entity's
 * own `module` field, or the chip either hides entities that belong to it or
 * shows ones that don't.
 */
describe("entityTypesForModule", () => {
  it("returns exactly the entity types registered under that module", () => {
    for (const mod of Object.keys(QUERY_MODULE_LABELS) as QueryModule[]) {
      const expected = Object.values(QUERY_ENTITIES)
        .filter((d) => d.module === mod)
        .map((d) => d.type)
        .sort();
      expect(entityTypesForModule(mod).sort()).toEqual(expected);
    }
  });

  it("never returns an entity type belonging to a different module", () => {
    for (const mod of Object.keys(QUERY_MODULE_LABELS) as QueryModule[]) {
      for (const type of entityTypesForModule(mod)) {
        expect(QUERY_ENTITIES[type].module).toBe(mod);
      }
    }
  });
});
