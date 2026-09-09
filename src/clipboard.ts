export interface ClipboardDependencies {
  document?: Pick<Document, 'body' | 'createElement' | 'execCommand'>;
  navigator?: {
    clipboard?: {
      writeText?: (text: string) => Promise<void> | void;
    };
  };
}

export async function copyTextToClipboard(
  text: string,
  dependencies: ClipboardDependencies = globalThis as ClipboardDependencies,
): Promise<boolean> {
  const writeText = dependencies.navigator?.clipboard?.writeText;

  if (writeText) {
    try {
      await writeText.call(dependencies.navigator?.clipboard, text);
      return true;
    } catch {
      // Sandboxed QDN views can reject the modern Clipboard API. Fall through
      // to the selection-based copy path while the button click is active.
    }
  }

  return copyTextWithTextarea(text, dependencies.document);
}

function copyTextWithTextarea(text: string, documentRef: ClipboardDependencies['document']): boolean {
  if (!documentRef?.body || !documentRef.createElement || !documentRef.execCommand) {
    return false;
  }

  const textarea = documentRef.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  documentRef.body.appendChild(textarea);

  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    return documentRef.execCommand('copy');
  } catch {
    return false;
  } finally {
    documentRef.body.removeChild(textarea);
  }
}
