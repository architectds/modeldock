// Capability corrections reuse the boolean preference serializer. They are
// independent of picker visibility and survive catalog refreshes and upgrades.
import { stateFile } from "./state-dir.mjs";
import { readModelToggles, writeModelToggles } from "./model-toggles.mjs";

export const visionOverridesPath = () => stateFile("vision-overrides.json");
export const readVisionOverrides = (file = visionOverridesPath()) => readModelToggles(file);
export const writeVisionOverrides = (file, values) => writeModelToggles(file, values);

const defaults = new WeakMap();

export function applyVisionOverrides(profiles, overrides, { publishedSlugFor }) {
  for (const profile of profiles) {
    // Remote directory discovery and the stable llama.cpp row both expose a
    // user correction surface. /props remains the observed default for local,
    // but an older server or a projector attached after that observation must
    // not make the correction disappear on the next catalog refresh.
    if (!profile.modelDiscovery && profile.id !== "llamacpp") continue;
    for (const model of profile.availableModels || []) {
      const value = overrides?.[publishedSlugFor(profile.id, model)];
      if (typeof value === "boolean") {
        if (!defaults.has(model)) defaults.set(model, {
          supportsVision: model.supportsVision,
          visionStatus: model.visionStatus,
        });
        model.supportsVision = value;
        model.visionStatus = "user";
      } else if (defaults.has(model)) {
        Object.assign(model, defaults.get(model));
        defaults.delete(model);
      }
    }
  }
}
