// Native ChatGPT identity is a routing/display fact shared by every picker and
// persisted model reference. Keep its id and label together so one consumer
// cannot invent a parallel spelling.
export const NATIVE_PROVIDER = Object.freeze({ id: "openai", label: "ChatGPT (native)" });
export const NATIVE_PROVIDER_ID = NATIVE_PROVIDER.id;
