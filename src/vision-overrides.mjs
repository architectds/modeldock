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
    // Native and managed local capabilities belong to their actual runtime.
    if (!profile.modelDiscovery) continue;
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
