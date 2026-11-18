'use strict';

const { createHash } = require('node:crypto');

const CUSTOM_PROMPT_CAPACITY = 3960;

function hasUnpairedSurrogate(text) {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function validateCustomPrompt(text) {
  if (typeof text !== 'string' || text.length === 0) throw new Error('自定义提示词不能为空且必须是文本');
  if (hasUnpairedSurrogate(text)) throw new Error('自定义提示词包含无效 UTF-8 字符');
  if (text.includes('\u0000')) throw new Error('自定义提示词不能包含 NUL 字符');
  if (text.includes('{{') || text.includes('}}')) throw new Error('自定义提示词不能包含 Go 模板分隔符');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > CUSTOM_PROMPT_CAPACITY) throw new Error(`自定义提示词超过 ${CUSTOM_PROMPT_CAPACITY} 字节容量`);
  return text;
}

function customPromptMetadata(text) {
  validateCustomPrompt(text);
  const bytes = Buffer.byteLength(text, 'utf8');
  return {
    bytes,
    hash: createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'),
    capacity: CUSTOM_PROMPT_CAPACITY
  };
}

module.exports = { CUSTOM_PROMPT_CAPACITY, validateCustomPrompt, customPromptMetadata };
