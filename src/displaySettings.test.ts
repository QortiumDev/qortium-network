import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyDisplaySettings,
  getDisplaySettingsUpdateFromMessage,
  getInitialDisplaySettings,
  normalizeUiStyle,
  type QdnDisplaySettings,
} from './displaySettings';

const current: QdnDisplaySettings = {
  accent: 'green',
  textSize: 'medium',
  theme: 'light',
  uiStyle: 'classic',
};

describe('display settings UI style', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalizes UI style values', () => {
    expect(normalizeUiStyle('MODERN')).toBe('modern');
    expect(normalizeUiStyle(' classic ')).toBe('classic');
    expect(normalizeUiStyle('retro')).toBeNull();
    expect(normalizeUiStyle(undefined)).toBeNull();
  });

  it('reads uiStyle from the render URL before host globals', () => {
    vi.stubGlobal('window', {
      _qdnAccent: 'yellow',
      _qdnTextSize: 'small',
      _qdnTheme: 'light',
      _qdnUiStyle: 'classic',
      location: {
        search: '?theme=dark&textSize=large&accent=blue&uiStyle=modern',
      },
    });

    expect(getInitialDisplaySettings()).toEqual({
      accent: 'blue',
      textSize: 'large',
      theme: 'dark',
      uiStyle: 'modern',
    });
  });

  it('falls back to classic for invalid or absent uiStyle values', () => {
    vi.stubGlobal('window', {
      _qdnUIStyle: 'retro',
      location: {
        search: '?uiStyle=banana',
      },
    });

    expect(getInitialDisplaySettings()).toMatchObject({
      uiStyle: 'classic',
    });
  });

  it('uses host uiStyle globals when no query value is present', () => {
    vi.stubGlobal('window', {
      _qdnUIStyle: 'modern',
      location: {
        search: '',
      },
    });

    expect(getInitialDisplaySettings()).toMatchObject({
      uiStyle: 'modern',
    });
  });

  it('updates UI style from UI_STYLE_CHANGED using Home aliases', () => {
    expect(getDisplaySettingsUpdateFromMessage({ action: 'UI_STYLE_CHANGED', requestedHandler: 'UI', uiStyle: 'modern' }, current)).toEqual({
      ...current,
      uiStyle: 'modern',
    });

    expect(getDisplaySettingsUpdateFromMessage({ action: 'UI_STYLE_CHANGED', qdnUIStyle: 'classic' }, { ...current, uiStyle: 'modern' })).toEqual(
      current,
    );
  });

  it('updates UI style inside batched display settings messages', () => {
    expect(
      getDisplaySettingsUpdateFromMessage(
        {
          action: 'DISPLAY_SETTINGS_CHANGED',
          accent: 'blue',
          qdnTextSize: 'large',
          theme: 'dark',
          uiStyle: 'modern',
        },
        current,
      ),
    ).toEqual({
      accent: 'blue',
      textSize: 'large',
      theme: 'dark',
      uiStyle: 'modern',
    });
  });

  it('ignores invalid UI style changes and non-UI handler messages', () => {
    expect(getDisplaySettingsUpdateFromMessage({ action: 'UI_STYLE_CHANGED', uiStyle: 'retro' }, current)).toBeNull();
    expect(getDisplaySettingsUpdateFromMessage({ action: 'UI_STYLE_CHANGED', requestedHandler: 'OTHER', uiStyle: 'modern' }, current)).toBeNull();
  });

  it('applies data-ui to the document root before paint', () => {
    const root = {
      dataset: {} as Record<string, string>,
      style: {} as Record<string, string>,
    };

    vi.stubGlobal('document', {
      documentElement: root,
    });

    applyDisplaySettings({
      accent: 'purple',
      textSize: 'huge',
      theme: 'dark',
      uiStyle: 'modern',
    });

    expect(root.dataset).toMatchObject({
      accent: 'purple',
      textSize: 'huge',
      theme: 'dark',
      ui: 'modern',
    });
    expect(root.style.colorScheme).toBe('dark');
  });
});
