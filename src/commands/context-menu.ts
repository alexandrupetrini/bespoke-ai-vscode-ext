import * as vscode from 'vscode';
import { BackendRouter } from '../providers/backend-router';
import { Logger } from '../utils/logger';
import { PermissionMode } from '../types';
import {
  buildClaudeCommand,
  escapeForDoubleQuotes,
  PromptContext,
  PROMPT_TEMPLATES,
} from './context-menu-utils';

/**
 * Opens a terminal in ViewColumn.Two and sends a Claude CLI command.
 */
async function openClaudeTerminal(command: string): Promise<vscode.Terminal> {
  const terminal = vscode.window.createTerminal({
    location: { viewColumn: vscode.ViewColumn.Two },
  });

  terminal.show(false);

  // Move to last tab position (alongside other Claude terminals)
  await vscode.commands.executeCommand('moveActiveEditor', {
    to: 'last',
    by: 'tab',
  });

  // Brief delay to ensure terminal is ready
  await new Promise((resolve) => setTimeout(resolve, 100));

  terminal.sendText(command);
  return terminal;
}

/**
 * Gets selection info from the active editor.
 * Returns null if no editor or selection is empty.
 *
 * Three states:
 * - Clean saved file: filePath set, unsaved false — Claude reads and edits the file directly
 * - Dirty saved file: filePath set, unsaved true — text embedded in prompt, file available for context
 * - Untitled buffer: filePath null, unsaved true — text embedded, no file to reference
 */
function getSelectionInfo(): {
  selectedText: string;
  filePath: string | null;
  startLine: number;
  endLine: number;
  unsaved: boolean;
} | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    return null;
  }

  const selectedText = editor.document.getText(editor.selection);
  const isUntitled = editor.document.isUntitled;
  const filePath = isUntitled ? null : editor.document.uri.fsPath;
  const unsaved = isUntitled || editor.document.isDirty;
  const startLine = editor.selection.start.line + 1; // 1-indexed
  // If selection ends at column 0, the user didn't select content on that line
  const endLine =
    editor.selection.end.character === 0 && editor.selection.end.line > editor.selection.start.line
      ? editor.selection.end.line
      : editor.selection.end.line + 1;

  return { selectedText, filePath, startLine, endLine, unsaved };
}

/** Builds a PromptContext with the selected text escaped for shell embedding. */
function buildPromptContext(sel: {
  selectedText: string;
  filePath: string | null;
  startLine: number;
  endLine: number;
  unsaved: boolean;
}): PromptContext {
  return {
    selectedText: escapeForDoubleQuotes(sel.selectedText),
    filePath: sel.filePath ? escapeForDoubleQuotes(sel.filePath) : null,
    startLine: sel.startLine,
    endLine: sel.endLine,
    unsaved: sel.unsaved,
  };
}

/**
 * Shows an input box and returns the user's input.
 * Returns undefined if the user pressed Escape (cancel).
 * When required is true, empty input is rejected with a validation message.
 */
async function getUserInput(options: {
  prompt: string;
  placeholder: string;
  required: boolean;
}): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt: options.prompt,
    placeHolder: options.placeholder,
    validateInput: options.required
      ? (value) => (value.trim() ? null : 'Please enter a message')
      : undefined,
  });
}

/**
 * Shows the result of a context menu command for the API backend.
 * Uses a diff view similar to suggest-edit for "Fix" and "Do" commands,
 * and an info message with copy action for "Explain".
 */
async function showApiCommandResult(
  logger: Logger,
  commandType: 'explain' | 'fix' | 'do',
  originalText: string,
  result: string,
  fileName: string,
  range: vscode.Range,
  document: vscode.TextDocument,
): Promise<void> {
  if (commandType === 'explain') {
    // For Explain, show in an info message with copy action
    const choice = await vscode.window.showInformationMessage(
      `Bespoke AI: Explanation`,
      { detail: result, modal: false },
      'Copy',
      'Dismiss',
    );
    if (choice === 'Copy') {
      await vscode.env.clipboard.writeText(result);
      vscode.window.setStatusBarMessage('Bespoke AI: Explanation copied to clipboard', 3000);
    }
    return;
  }

  // For Fix and Do, show diff view like suggest-edit
  const contentStore = new Map<string, string>();
  const key = `${fileName}-${Date.now()}`;
  contentStore.set(`original:${key}`, originalText);
  contentStore.set(`corrected:${key}`, result);

  const originalUri = vscode.Uri.from({ scheme: 'bespoke-edit-original', path: key });
  const correctedUri = vscode.Uri.from({ scheme: 'bespoke-edit-corrected', path: key });

  // Register content providers
  const disposableOriginal = vscode.workspace.registerTextDocumentContentProvider(
    'bespoke-edit-original',
    {
      provideTextDocumentContent(uri) {
        return contentStore.get(`original:${uri.path}`) ?? '';
      },
    },
  );
  const disposableCorrected = vscode.workspace.registerTextDocumentContentProvider(
    'bespoke-edit-corrected',
    {
      provideTextDocumentContent(uri) {
        return contentStore.get(`corrected:${uri.path}`) ?? '';
      },
    },
  );

  let choice: string | undefined;
  try {
    await vscode.commands.executeCommand(
      'vscode.diff',
      originalUri,
      correctedUri,
      `Bespoke AI: ${commandType === 'fix' ? 'Fix' : 'Do'} — ${fileName}`,
    );

    choice = await vscode.window.showInformationMessage(
      `Bespoke AI: Apply ${commandType === 'fix' ? 'fixes' : 'changes'}?`,
      'Apply',
      'Discard',
    );
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    disposableOriginal.dispose();
    disposableCorrected.dispose();
    contentStore.delete(`original:${key}`);
    contentStore.delete(`corrected:${key}`);
  }

  if (choice !== 'Apply') {
    logger.info(`Context menu ${commandType}: discarded by user`);
    return;
  }

  // Staleness check
  const documentVersionAtStart = document.version;
  if (editor.document.version !== documentVersionAtStart) {
    vscode.window.showWarningMessage('Bespoke AI: Document changed — discarding.');
    logger.info(`Context menu ${commandType}: discarded (document changed)`);
    return;
  }

  // Apply edit
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, range, result);
  await vscode.workspace.applyEdit(edit);

  vscode.window.setStatusBarMessage(
    `Bespoke AI: ${commandType === 'fix' ? 'Fixes' : 'Changes'} applied (Ctrl+Z to undo)`,
    4000,
  );
  logger.info(`Context menu ${commandType}: edits applied`);
}

// --- Handlers ---

interface ContextMenuHandlerOptions {
  router: BackendRouter;
  logger: Logger;
  permissionMode: PermissionMode;
  commandType: 'explain' | 'fix' | 'do';
  customInstruction?: string;
}

async function handleContextMenuCommand(options: ContextMenuHandlerOptions): Promise<void> {
  const { router, logger, permissionMode, commandType, customInstruction } = options;
  const sel = getSelectionInfo();
  if (!sel) return;

  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const document = editor.document;
  const range = editor.selection;
  const fileName = document.fileName.split('/').pop() || 'untitled';
  const originalText = document.getText(range);

  const ctx = buildPromptContext(sel);
  let prompt: string;

  switch (commandType) {
    case 'explain':
      prompt = PROMPT_TEMPLATES.explain(ctx);
      break;
    case 'fix':
      prompt = PROMPT_TEMPLATES.fix(ctx);
      break;
    case 'do':
      if (!customInstruction) return;
      const escaped = escapeForDoubleQuotes(customInstruction);
      prompt = PROMPT_TEMPLATES.do(ctx, escaped);
      break;
  }

  if (router.getBackend() === 'claude-code') {
    // CLI backend: open terminal
    await openClaudeTerminal(buildClaudeCommand(prompt, permissionMode));
  } else {
    // API backend: send through router
    logger.info(`Context menu ${commandType} (API backend)`);

    const { text } = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Bespoke AI: ${commandType === 'explain' ? 'Explaining' : commandType === 'fix' ? 'Fixing' : 'Applying'}...`,
        cancellable: true,
      },
      async (_progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());

        return router.sendCommand(prompt, {
          timeoutMs: 90_000,
          onCancel: controller.signal,
        });
      },
    );

    if (text === null) {
      return;
    }

    logger.trace(`Context menu ${commandType} raw response:\n${text}`);
    await showApiCommandResult(logger, commandType, originalText, text, fileName, range, document);
  }
}

export async function explainSelection(
  router: BackendRouter,
  logger: Logger,
  permissionMode: PermissionMode,
): Promise<void> {
  await handleContextMenuCommand({ router, logger, permissionMode, commandType: 'explain' });
}

export async function fixSelection(
  router: BackendRouter,
  logger: Logger,
  permissionMode: PermissionMode,
): Promise<void> {
  await handleContextMenuCommand({ router, logger, permissionMode, commandType: 'fix' });
}

export async function doSelection(
  router: BackendRouter,
  logger: Logger,
  permissionMode: PermissionMode,
): Promise<void> {
  const instruction = await getUserInput({
    prompt: 'What do you want to do with this text?',
    placeholder: 'e.g., "convert to a bullet list", "make it more formal"',
    required: true,
  });
  if (instruction === undefined) return; // Escape pressed
  await handleContextMenuCommand({
    router,
    logger,
    permissionMode,
    commandType: 'do',
    customInstruction: instruction,
  });
}
