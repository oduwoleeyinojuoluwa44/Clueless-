import { app, BrowserWindow, globalShortcut, ipcMain } from 'electron';
import { exec } from 'child_process';
import * as os from 'os';
import * as path from 'path';

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

type AiProvider = 'ollama' | 'openai-compatible';

type AiConfig = {
  provider: AiProvider;
  endpoint: string;
  model: string;
  apiKey: string;
  systemPrompt: string;
  timeoutMs: number;
};

type AiConfigPayload = {
  provider: AiProvider;
  model: string;
  endpointConfigured: boolean;
  apiKeyConfigured: boolean;
  systemPromptConfigured: boolean;
};

type AskResult = {
  ok: boolean;
  answer?: string;
  error?: string;
  provider?: AiProvider;
  model?: string;
};

// Capture-stealth is the whole point of the app, so it stays ON by default.
// "Hide" no longer means a vanishing window (you could never click it back) —
// it collapses the panel to a small nub that is always visible and clickable.
const EXPANDED_SIZE = { width: 460, height: 520 };
const COLLAPSED_SIZE = { width: 184, height: 60 };

let mainWindow: BrowserWindow | null = null;
let manualProtectionEnabled = true;
let collapsed = false;
let autoHideEnabled = false;
let shareGuardActive = false;
let userHidden = false;
let shareGuardTimer: NodeJS.Timeout | null = null;
let shareGuardChecking = false;
let lastProtectionError: string | null = null;
let warnedNoSupport = false;

// What the OS can actually deliver for setContentProtection. There is no API to
// read the flag back after it is set, so we report the platform's real ceiling
// rather than pretend we verified pixel-level invisibility.
//
// - 'full' : window is excluded from the captured frame
//            (Windows 10 build 19041+ via WDA_EXCLUDEFROMCAPTURE; macOS via NSWindowSharingNone)
// - 'weak' : older Windows only blanks the window during capture (WDA_MONITOR)
// - 'none' : platform has no support; the overlay WILL appear in captures
const getProtectionSupport = (): { level: ProtectionSupport; detail: string } => {
  if (process.platform === 'darwin') {
    return {
      level: 'full',
      detail: 'macOS: window excluded from capture (NSWindowSharingNone). Best-effort only — does not stop a camera pointed at the screen or a hardware capture card.',
    };
  }

  if (process.platform === 'win32') {
    const build = Number(os.release().split('.')[2] ?? '0');
    if (Number.isFinite(build) && build >= 19041) {
      return {
        level: 'full',
        detail: `Windows build ${build}: excluded from capture (WDA_EXCLUDEFROMCAPTURE). Best-effort only — does not stop a camera, a hardware capture card, or kernel-level proctoring.`,
      };
    }
    return {
      level: 'weak',
      detail: `Windows build ${build || 'unknown'}: only blanks the window during capture (WDA_MONITOR). Upgrade to build 19041+ (Win10 2004) for true exclusion.`,
    };
  }

  return {
    level: 'none',
    detail: `${process.platform}: content protection is not supported. The overlay WILL appear in screen captures and shares.`,
  };
};

const shareAppMatchers = [
  /obs/i,
  /streamlabs/i,
  /xsplit/i,
  /bandicam/i,
  /camtasia/i,
  /snagit/i,
  /zoom/i,
  /teams/i,
  /webex/i,
  /gotomeeting/i,
  /discord/i,
  /slack/i,
  /loom/i,
  /screenflow/i,
];

const normalizeProvider = (value?: string): AiProvider => {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === 'openai' || normalized === 'openai-compatible' || normalized === 'openai_compatible') {
    return 'openai-compatible';
  }
  return 'ollama';
};

const getAiConfig = (): AiConfig => {
  const provider = normalizeProvider(process.env.CLUEELESS_AI_PROVIDER);
  const endpoint =
    process.env.CLUEELESS_AI_ENDPOINT?.trim() ||
    (provider === 'ollama' ? 'http://localhost:11434/api/generate' : '');
  const model = process.env.CLUEELESS_AI_MODEL?.trim() || '';
  const apiKey = process.env.CLUEELESS_AI_API_KEY?.trim() || '';
  const systemPrompt = process.env.CLUEELESS_AI_SYSTEM?.trim() || '';
  const timeoutMs = Number(process.env.CLUEELESS_AI_TIMEOUT_MS) || 30000;

  return {
    provider,
    endpoint,
    model,
    apiKey,
    systemPrompt,
    timeoutMs,
  };
};

const getAiConfigPayload = (): AiConfigPayload => {
  const { provider, model, endpoint, apiKey, systemPrompt } = getAiConfig();
  return {
    provider,
    model,
    endpointConfigured: Boolean(endpoint),
    apiKeyConfigured: Boolean(apiKey),
    systemPromptConfigured: Boolean(systemPrompt),
  };
};

const fetchWithTimeout = async (url: string, options: RequestInit, timeoutMs: number) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};

const parseErrorMessage = async (response: Response) => {
  try {
    const data = await response.json();
    if (data?.error?.message) {
      return String(data.error.message);
    }
  } catch {
    // ignore
  }

  try {
    const text = await response.text();
    if (text) {
      return text.slice(0, 400);
    }
  } catch {
    // ignore
  }

  return `Request failed with status ${response.status}.`;
};

const requestOllama = async (config: AiConfig, prompt: string) => {
  const response = await fetchWithTimeout(
    config.endpoint,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        prompt,
        stream: false,
        ...(config.systemPrompt ? { system: config.systemPrompt } : {}),
      }),
    },
    config.timeoutMs,
  );

  if (!response.ok) {
    const message = await parseErrorMessage(response);
    throw new Error(message);
  }

  const data = (await response.json()) as {
    response?: string;
    message?: { content?: string };
    text?: string;
    output_text?: string;
  };

  const answer =
    data.response ?? data.message?.content ?? data.output_text ?? data.text ?? '';

  if (!answer) {
    throw new Error('No answer returned from the AI provider.');
  }

  return answer;
};

const requestOpenAiCompatible = async (config: AiConfig, prompt: string) => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
  if (config.systemPrompt) {
    messages.push({ role: 'system', content: config.systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  const response = await fetchWithTimeout(
    config.endpoint,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0.2,
        stream: false,
      }),
    },
    config.timeoutMs,
  );

  if (!response.ok) {
    const message = await parseErrorMessage(response);
    throw new Error(message);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string }; text?: string }>;
    output_text?: string;
    text?: string;
  };

  const answer =
    data.choices?.[0]?.message?.content ??
    data.choices?.[0]?.text ??
    data.output_text ??
    data.text ??
    '';

  if (!answer) {
    throw new Error('No answer returned from the AI provider.');
  }

  return answer;
};

const execAsync = (command: string) =>
  new Promise<string>((resolve) => {
    exec(command, { windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve('');
        return;
      }
      resolve(stdout ?? '');
    });
  });

const listRunningProcesses = async () => {
  if (process.platform === 'win32') {
    const output = await execAsync('tasklist /FO CSV /NH');
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split('","')[0]?.replace(/^"|"$/g, '') ?? '')
      .filter(Boolean)
      .map((name) => name.toLowerCase());
  }

  const output = await execAsync('ps -A -o comm');
  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((name) => path.basename(name).toLowerCase());
};

const detectShareApps = async () => {
  const processes = await listRunningProcesses();
  if (processes.length === 0) {
    return false;
  }

  return processes.some((name) => shareAppMatchers.some((matcher) => matcher.test(name)));
};

const getStatusPayload = (): StatusPayload => {
  const effectiveProtection = manualProtectionEnabled || shareGuardActive;
  const isHidden = userHidden || (autoHideEnabled && shareGuardActive);
  const support = getProtectionSupport();
  return {
    manualProtectionEnabled,
    effectiveProtection,
    autoHideEnabled,
    shareGuardActive,
    isHidden,
    collapsed,
    protectionSupport: support.level,
    protectionDetail: support.detail,
    protectionError: lastProtectionError,
  };
};

const emitStatus = () => {
  if (!mainWindow) {
    return;
  }
  mainWindow.webContents.send('status', getStatusPayload());
};

const applyWindowState = () => {
  if (!mainWindow) {
    return;
  }

  const { effectiveProtection, isHidden } = getStatusPayload();

  try {
    mainWindow.setContentProtection(effectiveProtection);
    lastProtectionError = null;
  } catch (error) {
    lastProtectionError = error instanceof Error ? error.message : String(error);
    console.error(`[clueeless] setContentProtection failed: ${lastProtectionError}`);
  }

  // Fail loudly when protection is requested but the platform can't deliver it,
  // instead of silently leaving the user thinking they're hidden.
  if (effectiveProtection) {
    const support = getProtectionSupport();
    if (support.level === 'none') {
      console.warn(`[clueeless] PROTECTION REQUESTED BUT UNSUPPORTED — ${support.detail}`);
    } else if (support.level === 'weak' && !warnedNoSupport) {
      console.warn(`[clueeless] Protection is WEAK on this system — ${support.detail}`);
      warnedNoSupport = true;
    }
  }

  // Collapse to a small nub instead of hiding the window outright, so it's
  // always on screen and one click away from coming back. The window must
  // physically shrink — otherwise the old full-size (transparent) window keeps
  // swallowing clicks meant for whatever is behind it.
  const size = collapsed ? COLLAPSED_SIZE : EXPANDED_SIZE;
  const [currentWidth, currentHeight] = mainWindow.getSize();
  if (currentWidth !== size.width || currentHeight !== size.height) {
    // setSize is ignored on Windows while resizable is false, so flip it
    // around the resize and put it back.
    const wasResizable = mainWindow.isResizable();
    if (!wasResizable) {
      mainWindow.setResizable(true);
    }
    mainWindow.setSize(size.width, size.height);
    if (!wasResizable) {
      mainWindow.setResizable(false);
    }
  }

  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
};

const startShareGuard = () => {
  if (shareGuardTimer) {
    return;
  }

  shareGuardTimer = setInterval(async () => {
    if (shareGuardChecking) {
      return;
    }
    shareGuardChecking = true;
    try {
      const active = await detectShareApps();
      if (active !== shareGuardActive) {
        shareGuardActive = active;
        applyWindowState();
        emitStatus();
      }
    } finally {
      shareGuardChecking = false;
    }
  }, 2000);
};

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 460,
    height: 520,
    transparent: true,
    alwaysOnTop: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  applyWindowState();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  emitStatus();
};

ipcMain.handle('toggle-collapse', () => {
  collapsed = !collapsed;
  applyWindowState();
  emitStatus();
  return getStatusPayload();
});

ipcMain.handle('toggle-protection', () => {
  manualProtectionEnabled = !manualProtectionEnabled;
  applyWindowState();
  emitStatus();
  return getStatusPayload();
});

ipcMain.handle('toggle-auto-hide', () => {
  autoHideEnabled = !autoHideEnabled;
  applyWindowState();
  emitStatus();
  return getStatusPayload();
});

ipcMain.handle('get-status', () => getStatusPayload());

ipcMain.handle('get-ai-config', () => getAiConfigPayload());

ipcMain.handle('ask', async (_event, prompt: string): Promise<AskResult> => {
  const cleanedPrompt = typeof prompt === 'string' ? prompt.trim() : '';
  if (!cleanedPrompt) {
    return { ok: false, error: 'Prompt is empty.' };
  }

  const config = getAiConfig();
  if (!config.endpoint) {
    return { ok: false, error: 'Set CLUEELESS_AI_ENDPOINT to your AI server URL.' };
  }
  if (!config.model) {
    return { ok: false, error: 'Set CLUEELESS_AI_MODEL to your model name.' };
  }

  try {
    const answer =
      config.provider === 'openai-compatible'
        ? await requestOpenAiCompatible(config, cleanedPrompt)
        : await requestOllama(config, cleanedPrompt);

    return {
      ok: true,
      answer: answer.trim(),
      provider: config.provider,
      model: config.model,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch AI response.';
    return {
      ok: false,
      error: message,
    };
  }
});

app.whenReady().then(() => {
  const support = getProtectionSupport();
  console.log(`[clueeless] Capture protection support: ${support.level.toUpperCase()} — ${support.detail}`);

  createWindow();
  startShareGuard();

  globalShortcut.register('CommandOrControl+Shift+H', () => {
    collapsed = !collapsed;
    applyWindowState();
    emitStatus();
  });

  globalShortcut.register('CommandOrControl+Shift+P', () => {
    manualProtectionEnabled = !manualProtectionEnabled;
    applyWindowState();
    emitStatus();
  });

  globalShortcut.register('CommandOrControl+Shift+A', () => {
    autoHideEnabled = !autoHideEnabled;
    applyWindowState();
    emitStatus();
  });
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (shareGuardTimer) {
    clearInterval(shareGuardTimer);
    shareGuardTimer = null;
  }
});
