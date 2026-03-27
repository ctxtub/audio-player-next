import { describe, it, expect } from 'vitest';
import { encodeSession, decodeSession } from './session';

describe('session 编解码', () => {
  it('正常编解码往返一致', () => {
    const result = decodeSession(encodeSession(42, 'alice'));
    expect(result).toEqual({ userId: 42, nickname: 'alice' });
  });

  it('支持 Unicode 昵称（中文）', () => {
    const result = decodeSession(encodeSession(1, '小明'));
    expect(result).toEqual({ userId: 1, nickname: '小明' });
  });

  it('支持 Emoji 昵称', () => {
    const result = decodeSession(encodeSession(1, '🎵音乐'));
    expect(result).toEqual({ userId: 1, nickname: '🎵音乐' });
  });

  it('无效 base64 返回 null', () => {
    expect(decodeSession('not-valid-base64!!!')).toBeNull();
  });

  it('空字符串返回 null', () => {
    expect(decodeSession('')).toBeNull();
  });

  it('缺少 userId 返回 null', () => {
    const encoded = btoa(JSON.stringify({ nickname: 'alice' }));
    expect(decodeSession(encoded)).toBeNull();
  });

  it('缺少 nickname 返回 null', () => {
    const encoded = btoa(JSON.stringify({ userId: 1 }));
    expect(decodeSession(encoded)).toBeNull();
  });

  it('JSON 格式错误返回 null', () => {
    const encoded = btoa('{broken json');
    expect(decodeSession(encoded)).toBeNull();
  });
});
