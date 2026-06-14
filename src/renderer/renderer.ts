declare global {
  interface Window {
    clueless: {
      toggleProtection: () => Promise<StatusPayload>;
      toggleCollapse: () => Promise<StatusPayload>;
      toggleAutoHide: () => Promise<StatusPayload>;
      getStatus: () => Promise<StatusPayload>;
      getAiConfig: () => Promise<AiConfigPayload>;
      ask: (prompt: string) => Promise<AskResult>;
      onStatus: (listener: (status: StatusPayload) => void) => () => void;
    };
  }
}

type ProtectionSupport = 'full' | 'weak' | 'none';

type StatusPayload = {
  manualProtectionEnabled: boolean;
  effectiveProtection: boolean;
  autoHideEnabled: boolean;
  shareGuardActive: boolean;
  isHidden: boolean;
  collapsed: boolean;
  protectionSupport: ProtectionSupport;
  protectionDetail: string;
  protectionError: string | null;
};

type AiConfigPayload = {
  provider: 'ollama' | 'openai-compatible';
  model: string;
  endpointConfigured: boolean;
  apiKeyConfigured: boolean;
  systemPromptConfigured: boolean;
};

type AskResult = {
  ok: boolean;
  answer?: string;
  error?: string;
  provider?: 'ollama' | 'openai-compatible';
  model?: string;
};

const collapseLabel = document.getElementById('collapse-label');
const supportDot = document.getElementById('support-dot');
const nubDot = document.getElementById('nub-dot');
const collapseBtn = document.getElementById('toggle-collapse');
const nubExpand = document.getElementById('nub-expand');
const promptInput = document.getElementById('prompt-input');
const askBtn = document.getElementById('ask-button');
const clearBtn = document.getElementById('clear-button');
const answerEl = document.getElementById('answer');
const aiMetaEl = document.getElementById('ai-meta');
const aiStatusEl = document.getElementById('ai-status');

if (
  !(collapseLabel instanceof HTMLElement) ||
  !(supportDot instanceof HTMLElement) ||
  !(nubDot instanceof HTMLElement) ||
  !(collapseBtn instanceof HTMLButtonElement) ||
  !(nubExpand instanceof HTMLButtonElement) ||
  !(promptInput instanceof HTMLTextAreaElement) ||
  !(askBtn instanceof HTMLButtonElement) ||
  !(clearBtn instanceof HTMLButtonElement) ||
  !(answerEl instanceof HTMLElement) ||
  !(aiMetaEl instanceof HTMLElement) ||
  !(aiStatusEl instanceof HTMLElement)
) {
  throw new Error('Missing UI elements.');
}

const setUi = (status: StatusPayload) => {
  document.body.dataset.enabled = status.effectiveProtection ? 'on' : 'off';
  document.body.dataset.collapsed = status.collapsed ? 'on' : 'off';
  collapseBtn.dataset.state = status.effectiveProtection ? 'on' : 'off';
  collapseLabel.textContent = 'Hide';

  // The dot keeps the honest signal: green = OS can exclude us, amber = weak,
  // red = unsupported. Full detail lives in the tooltip, not as on-screen clutter.
  supportDot.dataset.level = status.protectionSupport;
  nubDot.dataset.level = status.protectionSupport;
  let tooltip = status.protectionDetail;
  if (status.protectionError) {
    tooltip = `Protection failed to apply: ${status.protectionError}`;
  } else if (status.effectiveProtection && status.protectionSupport !== 'full') {
    tooltip = `Stealth ON but NOT reliable here — you may still be visible. ${status.protectionDetail}`;
  }
  collapseBtn.title = tooltip;
};

const updateAiMeta = (config: AiConfigPayload) => {
  const providerLabel = config.provider === 'openai-compatible' ? 'OpenAI-compatible' : 'Ollama';
  const modelLabel = config.model ? config.model : 'model unset';
  aiMetaEl.textContent = `AI: ${providerLabel} | ${modelLabel}`;

  if (!config.endpointConfigured || !config.model) {
    aiStatusEl.textContent = 'Not configured';
    return;
  }

  aiStatusEl.textContent = 'Ready';
};

const setBusy = (isBusy: boolean) => {
  document.body.dataset.busy = isBusy ? 'on' : 'off';
  askBtn.disabled = isBusy;
  promptInput.disabled = isBusy;
  clearBtn.disabled = isBusy;
};

const setAnswer = (message: string, tone: 'ok' | 'error' | 'idle' = 'ok') => {
  answerEl.dataset.state = tone;
  answerEl.textContent = message;
};

const handleAsk = async () => {
  const prompt = promptInput.value.trim();
  if (!prompt) {
    setAnswer('Type a prompt to ask the assistant.', 'error');
    return;
  }

  setBusy(true);
  aiStatusEl.textContent = 'Thinking...';
  setAnswer('Thinking...', 'idle');

  const result: AskResult = await window.clueless.ask(prompt);
  if (result.ok && result.answer) {
    setAnswer(result.answer.trim(), 'ok');
    aiStatusEl.textContent = 'Ready';
    if (result.provider && result.model) {
      aiMetaEl.textContent = `AI: ${
        result.provider === 'openai-compatible' ? 'OpenAI-compatible' : 'Ollama'
      } | ${result.model}`;
    }
  } else {
    setAnswer(result.error ?? 'Something went wrong while asking the assistant.', 'error');
    aiStatusEl.textContent = 'Error';
  }

  setBusy(false);
};

const init = async () => {
  const status = await window.clueless.getStatus();
  setUi(status);

  const aiConfig = await window.clueless.getAiConfig();
  updateAiMeta(aiConfig);
  setAnswer('Ask anything. Enter to send, Shift+Enter for a new line.', 'idle');
};

collapseBtn.addEventListener('click', async () => {
  const status = await window.clueless.toggleCollapse();
  setUi(status);
});

nubExpand.addEventListener('click', async () => {
  const status = await window.clueless.toggleCollapse();
  setUi(status);
});

askBtn.addEventListener('click', async () => {
  await handleAsk();
});

promptInput.addEventListener('keydown', async (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    await handleAsk();
  }
});

clearBtn.addEventListener('click', () => {
  promptInput.value = '';
  setAnswer('Cleared. Ask another prompt.', 'idle');
});

window.clueless.onStatus((status) => {
  setUi(status);
});

void init();

export {};
