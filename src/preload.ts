import { contextBridge, ipcRenderer } from 'electron';

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

const api = {
  toggleProtection: () => ipcRenderer.invoke('toggle-protection') as Promise<StatusPayload>,
  toggleCollapse: () => ipcRenderer.invoke('toggle-collapse') as Promise<StatusPayload>,
  toggleAutoHide: () => ipcRenderer.invoke('toggle-auto-hide') as Promise<StatusPayload>,
  getStatus: () => ipcRenderer.invoke('get-status') as Promise<StatusPayload>,
  getAiConfig: () => ipcRenderer.invoke('get-ai-config') as Promise<AiConfigPayload>,
  ask: (prompt: string) => ipcRenderer.invoke('ask', prompt) as Promise<AskResult>,
  onStatus: (listener: (status: StatusPayload) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, status: StatusPayload) => {
      listener(status);
    };
    ipcRenderer.on('status', wrapped);
    return () => ipcRenderer.removeListener('status', wrapped);
  },
};

contextBridge.exposeInMainWorld('clueless', api);
