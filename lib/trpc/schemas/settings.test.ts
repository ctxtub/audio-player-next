import { describe, it, expect } from 'vitest';
import { saveSettingsSchema } from './settings';

describe('saveSettingsSchema', () => {
  it('空对象通过（所有字段可选）', () => {
    expect(() => saveSettingsSchema.parse({})).not.toThrow();
  });

  it('完整合法输入通过', () => {
    expect(() =>
      saveSettingsSchema.parse({
        playDuration: 30,
        voiceId: 'alloy',
        speed: 1.0,
        floatingPlayerEnabled: true,
        themeMode: 'dark',
      })
    ).not.toThrow();
  });

  /** playDuration 边界 */
  it('playDuration 最小值 10 通过', () => {
    expect(() => saveSettingsSchema.parse({ playDuration: 10 })).not.toThrow();
  });

  it('playDuration 低于 10 拒绝', () => {
    expect(() => saveSettingsSchema.parse({ playDuration: 9 })).toThrow();
  });

  it('playDuration 最大值 60 通过', () => {
    expect(() => saveSettingsSchema.parse({ playDuration: 60 })).not.toThrow();
  });

  it('playDuration 超过 60 拒绝', () => {
    expect(() => saveSettingsSchema.parse({ playDuration: 61 })).toThrow();
  });

  it('playDuration 必须为整数', () => {
    expect(() => saveSettingsSchema.parse({ playDuration: 10.5 })).toThrow();
  });

  /** speed 边界 */
  it('speed 最小值 0.25 通过', () => {
    expect(() => saveSettingsSchema.parse({ speed: 0.25 })).not.toThrow();
  });

  it('speed 低于 0.25 拒绝', () => {
    expect(() => saveSettingsSchema.parse({ speed: 0.24 })).toThrow();
  });

  it('speed 最大值 4.0 通过', () => {
    expect(() => saveSettingsSchema.parse({ speed: 4.0 })).not.toThrow();
  });

  it('speed 超过 4.0 拒绝', () => {
    expect(() => saveSettingsSchema.parse({ speed: 4.1 })).toThrow();
  });

  /** voiceId */
  it('voiceId 空字符串拒绝', () => {
    expect(() => saveSettingsSchema.parse({ voiceId: '' })).toThrow();
  });

  it('voiceId 合法字符串通过', () => {
    expect(() => saveSettingsSchema.parse({ voiceId: 'shimmer' })).not.toThrow();
  });

  /** themeMode */
  it('themeMode light/dark/system 通过', () => {
    for (const mode of ['light', 'dark', 'system']) {
      expect(() => saveSettingsSchema.parse({ themeMode: mode })).not.toThrow();
    }
  });

  it('themeMode 非法值拒绝', () => {
    expect(() => saveSettingsSchema.parse({ themeMode: 'auto' })).toThrow();
  });

  /** floatingPlayerEnabled */
  it('floatingPlayerEnabled 非布尔值拒绝', () => {
    expect(() => saveSettingsSchema.parse({ floatingPlayerEnabled: 'yes' })).toThrow();
  });
});
