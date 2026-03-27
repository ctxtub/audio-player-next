import { describe, it, expect } from 'vitest';
import { loginInputSchema, registerInputSchema } from './auth';

describe('loginInputSchema', () => {
  it('合法输入通过', () => {
    expect(() => loginInputSchema.parse({ username: 'u', password: 'p' })).not.toThrow();
  });

  it('空用户名拒绝', () => {
    expect(() => loginInputSchema.parse({ username: '', password: 'p' })).toThrow();
  });

  it('空密码拒绝', () => {
    expect(() => loginInputSchema.parse({ username: 'u', password: '' })).toThrow();
  });

  it('缺少字段拒绝', () => {
    expect(() => loginInputSchema.parse({})).toThrow();
  });
});

describe('registerInputSchema', () => {
  it('合法输入通过', () => {
    expect(() =>
      registerInputSchema.parse({ username: 'ab', password: '123456' })
    ).not.toThrow();
  });

  it('带 nickname 通过', () => {
    expect(() =>
      registerInputSchema.parse({ username: 'ab', password: '123456', nickname: '小明' })
    ).not.toThrow();
  });

  it('username 少于 2 字符拒绝', () => {
    expect(() =>
      registerInputSchema.parse({ username: 'a', password: '123456' })
    ).toThrow();
  });

  it('username 超过 32 字符拒绝', () => {
    expect(() =>
      registerInputSchema.parse({ username: 'a'.repeat(33), password: '123456' })
    ).toThrow();
  });

  it('password 少于 6 字符拒绝', () => {
    expect(() =>
      registerInputSchema.parse({ username: 'ab', password: '12345' })
    ).toThrow();
  });

  it('password 超过 64 字符拒绝', () => {
    expect(() =>
      registerInputSchema.parse({ username: 'ab', password: 'x'.repeat(65) })
    ).toThrow();
  });

  it('nickname 超过 32 字符拒绝', () => {
    expect(() =>
      registerInputSchema.parse({
        username: 'ab',
        password: '123456',
        nickname: '名'.repeat(33),
      })
    ).toThrow();
  });

  it('username 边界 32 字符通过', () => {
    expect(() =>
      registerInputSchema.parse({ username: 'a'.repeat(32), password: '123456' })
    ).not.toThrow();
  });

  it('password 边界 6 字符通过', () => {
    expect(() =>
      registerInputSchema.parse({ username: 'ab', password: '123456' })
    ).not.toThrow();
  });

  it('password 边界 64 字符通过', () => {
    expect(() =>
      registerInputSchema.parse({ username: 'ab', password: 'x'.repeat(64) })
    ).not.toThrow();
  });
});
