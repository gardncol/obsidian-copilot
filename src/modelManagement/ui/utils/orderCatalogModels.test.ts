import type { ModelInfo } from "@/modelManagement/types/catalog";
import { orderCatalogModels } from "./orderCatalogModels";

const model = (id: string, releaseDate?: string): ModelInfo => ({
  id,
  displayName: id,
  releaseDate,
});

const ids = (models: readonly ModelInfo[]): string[] => models.map((m) => m.id);

describe("orderCatalogModels", () => {
  it("floats checked models above unchecked, regardless of date", () => {
    const models = [
      model("a", "2025-01-01"), // unchecked, newest
      model("b", "2024-01-01"), // checked, older
      model("c", "2023-01-01"), // unchecked, oldest
    ];
    const result = orderCatalogModels(models, new Set(["b"]));
    expect(ids(result)).toEqual(["b", "a", "c"]);
  });

  it("orders newest release date first within a group", () => {
    const models = [
      model("old", "2024-03-01"),
      model("new", "2025-09-01"),
      model("mid", "2025-01-01"),
    ];
    const result = orderCatalogModels(models, new Set());
    expect(ids(result)).toEqual(["new", "mid", "old"]);
  });

  it("sinks undated and unparseable models to the bottom of their group", () => {
    const models = [model("undated"), model("dated", "2025-01-01"), model("garbage", "not-a-date")];
    const result = orderCatalogModels(models, new Set());
    expect(result[0].id).toBe("dated");
    expect(ids(result).slice(1).sort()).toEqual(["garbage", "undated"]);
  });

  it("does not mutate the input array", () => {
    const models = [model("a", "2024-01-01"), model("b", "2025-01-01")];
    const snapshot = ids(models);
    orderCatalogModels(models, new Set(["a"]));
    expect(ids(models)).toEqual(snapshot);
  });
});
