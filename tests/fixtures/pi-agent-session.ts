import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { InMemoryCredentialStore, type FauxProviderRegistration, type FauxResponseStep } from "@earendil-works/pi-ai";
import { registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import { AgentSession, convertToLlm, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager, type ResourceLoader } from "@earendil-works/pi-coding-agent";

/** Minimal public-API adaptation of Pi's MIT-licensed v0.84 test harness. */
export interface PiAgentSessionHarness {
  agent: Agent;
  session: AgentSession;
  sessionManager: SessionManager;
  setResponses(responses: FauxResponseStep[]): void;
  cleanup(): void;
}

function createEmptyResourceLoader(): ResourceLoader {
  const extensionsResult = {
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime(),
  };

  return {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function registerRuntimeProvider(runtime: ModelRuntime, faux: FauxProviderRegistration): void {
  const model = faux.getModel();
  runtime.registerProvider(model.provider, {
    baseUrl: model.baseUrl,
    apiKey: "faux-key",
    api: faux.api,
    models: faux.models.map((registeredModel) => ({
      id: registeredModel.id,
      name: registeredModel.name,
      api: registeredModel.api,
      reasoning: registeredModel.reasoning,
      input: registeredModel.input,
      cost: registeredModel.cost,
      contextWindow: registeredModel.contextWindow,
      maxTokens: registeredModel.maxTokens,
      baseUrl: registeredModel.baseUrl,
    })),
  });
}

export async function createPiAgentSessionHarness(tools: AgentTool[]): Promise<PiAgentSessionHarness> {
  const faux = registerFauxProvider();
  faux.setResponses([]);
  const model = faux.getModel();

  const credentials = new InMemoryCredentialStore();
  await credentials.modify(model.provider, async () => ({
    type: "api_key",
    key: "faux-key",
  }));
  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    allowModelNetwork: false,
  });
  registerRuntimeProvider(modelRuntime, faux);

  const agent = new Agent({
    getApiKey: () => "faux-key",
    streamFn: streamSimple,
    initialState: {
      model,
      systemPrompt: "You are a test assistant.",
      tools: [],
    },
    convertToLlm,
  });
  const sessionManager = SessionManager.inMemory();
  const settingsManager = SettingsManager.inMemory({
    compaction: {
      enabled: true,
      reserveTokens: 1_024,
      keepRecentTokens: 1_000,
    },
  });
  const session = new AgentSession({
    agent,
    sessionManager,
    settingsManager,
    cwd: process.cwd(),
    modelRuntime,
    resourceLoader: createEmptyResourceLoader(),
    baseToolsOverride: Object.fromEntries(tools.map((tool) => [tool.name, tool])),
    initialActiveToolNames: tools.map((tool) => tool.name),
  });

  return {
    agent,
    session,
    sessionManager,
    setResponses: faux.setResponses,
    cleanup() {
      session.dispose();
      faux.unregister();
    },
  };
}
