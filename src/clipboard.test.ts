import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyTextToClipboard, type ClipboardDependencies } from './clipboard';

function mockDocument(execCommandResult: boolean) {
  const textarea = {
    value: '',
    style: {} as Record<string, string>,
    setAttribute: vi.fn(),
    focus: vi.fn(),
    select: vi.fn(),
    setSelectionRange: vi.fn(),
  };

  return {
    body: {
      appendChild: vi.fn(),
      removeChild: vi.fn(),
    },
    createElement: vi.fn(() => textarea),
    execCommand: vi.fn(() => execCommandResult),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('copyTextToClipboard', () => {
  it('uses navigator.clipboard when available and succeeds', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const dependencies: ClipboardDependencies = { navigator: { clipboard: { writeText } } };

    await expect(copyTextToClipboard('Network schema', dependencies)).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('Network schema');
  });

  it('falls back to a selected textarea when the modern API is unavailable', async () => {
    const fallbackDocument = mockDocument(true);
    const dependencies: ClipboardDependencies = {
      document: fallbackDocument as unknown as ClipboardDependencies['document'],
      navigator: { clipboard: {} },
    };

    await expect(copyTextToClipboard('Fallback code', dependencies)).resolves.toBe(true);
    expect(fallbackDocument.createElement).toHaveBeenCalledWith('textarea');
    expect(fallbackDocument.execCommand).toHaveBeenCalledWith('copy');
    expect(fallbackDocument.body.removeChild).toHaveBeenCalledTimes(1);
  });

  it('falls back after rejection and reports unavailable when selection copy fails', async () => {
    const fallbackDocument = mockDocument(false);
    const dependencies: ClipboardDependencies = {
      document: fallbackDocument as unknown as ClipboardDependencies['document'],
      navigator: { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('blocked')) } },
    };

    await expect(copyTextToClipboard('Unavailable code', dependencies)).resolves.toBe(false);
    expect(fallbackDocument.execCommand).toHaveBeenCalledWith('copy');
  });

  it('returns unavailable without browser clipboard surfaces', async () => {
    await expect(copyTextToClipboard('No browser', {})).resolves.toBe(false);
  });
});
