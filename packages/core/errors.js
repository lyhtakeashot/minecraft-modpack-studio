/**
 * 本项目统一的错误类型：带 `hint` 的失败会被界面和 MCP 服务器渲染成「失败原因 + 提示」，
 * 让模型读到可以纠正的具体原因，而不是一个栈。
 */
export class McError extends Error {
  /**
   * @param {string} message 面向模型/用户的失败原因
   * @param {string} [hint] 下一步该怎么做的提示
   * @param {string} [code] 机器可读的失败码
   */
  constructor(message, hint = '', code = 'McError') {
    super(message);
    this.name = 'McError';
    this.hint = hint;
    this.code = code;
  }
}

/** 断言一个值存在，否则抛 McError。 */
export function need(value, message, hint = '') {
  if (value === undefined || value === null || value === '') {
    throw new McError(message, hint, 'McNeed');
  }
  return value;
}
