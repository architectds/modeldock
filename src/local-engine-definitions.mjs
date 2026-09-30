// Stable local-engine identity and defaults. Discovery and the dashboard
// project from this table; a port is a default probe target,
// never evidence of which engine actually answered there.

export const LOCAL_ENGINE_DEFINITIONS = Object.freeze({
  ollama: Object.freeze({ id: "ollama", label: "Ollama", defaultPort: 11434 }),
  llamacpp: Object.freeze({ id: "llamacpp", label: "llama.cpp", defaultPort: 8080 }),
  vllm: Object.freeze({ id: "vllm", label: "vLLM", defaultPort: 8000 }),
  openai: Object.freeze({ id: "openai", label: "OpenAI-compatible", defaultPort: 0 }),
});

export function localEngineDefinition(id) {
  return LOCAL_ENGINE_DEFINITIONS[id] || null;
}

export function localEngineDefinitions() {
  return Object.values(LOCAL_ENGINE_DEFINITIONS);
}
