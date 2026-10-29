'use strict';

function usesResponsesApi(model) { return /^gpt-6(?:[.-]|$)/.test(model || ''); }

function responsesInput(messages) {
  return messages.flatMap(message => {
    if (message.role === 'tool') return [{ type: 'function_call_output', call_id: message.tool_call_id, output: message.content }];
    const items = message.content ? [{ role: message.role, content: message.content }] : [];
    for (const call of message.tool_calls || []) items.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    return items;
  });
}

function responsesRequest({ model, messages, tools }, context) {
  // Carry the exact reasoning/function output from the previous response through
  // the current tool loop. This remains in memory; it is never saved to chat.
  const input = context?.model === model ? [...context.input, ...responsesInput(messages.slice(context.messageCount + 1))] : responsesInput(messages);
  return { model, input, stream: false, store: false, include: ['reasoning.encrypted_content'], max_output_tokens: 8192,
    ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', ...tool.function })), tool_choice: 'auto' } : {}) };
}

function responsesResult(result) {
  const output = Array.isArray(result?.output) ? result.output : [];
  const calls = output.filter(item => item.type === 'function_call').map(item => ({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } }));
  const content = output.filter(item => item.type === 'message').flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('\n');
  return { choices: [{ message: { role: 'assistant', content: content || null, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: result?.status !== 'completed' ? 'length' : calls.length ? 'tool_calls' : 'stop' }],
    usage: result?.usage && { prompt_tokens: result.usage.input_tokens, completion_tokens: result.usage.output_tokens, total_tokens: result.usage.total_tokens } };
}

module.exports = { usesResponsesApi, responsesRequest, responsesResult };
