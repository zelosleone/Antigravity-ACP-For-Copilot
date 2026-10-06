import * as vscode from 'vscode';
import { AntigravityChatProvider } from './provider.js';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Antigravity for Copilot', { log: true });
  const provider = new AntigravityChatProvider(context, log);

  context.subscriptions.push(
    log,
    provider,
    vscode.lm.registerLanguageModelChatProvider('antigravity-acp', provider),
    vscode.commands.registerCommand('antigravityAcp.signIn', () => provider.signIn()),
    vscode.commands.registerCommand('antigravityAcp.manage', () => manage(provider, log)),
  );
  provider.start();
}

async function manage(provider: AntigravityChatProvider, log: vscode.LogOutputChannel): Promise<void> {
  const actions: Record<string, () => unknown> = {
    'Sign In...': () => provider.signIn(),
    'Sign Out': () => provider.signOut(),
    'Refresh Models': () => provider.refresh(),
    'Restart Server': () => provider.restart(),
    'Show Logs': () => log.show(),
  };
  const choice = await vscode.window.showQuickPick(Object.keys(actions), { title: provider.describe() });
  if (choice) await actions[choice]();
}
