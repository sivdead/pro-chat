import { merge, template } from 'lodash-es';
import { StateCreator } from 'zustand/vanilla';

import { LOADING_FLAT } from '@/ProChat/const/message';
import { ChatStore } from '@/ProChat/store/index';
import { fetchSSE } from '@/ProChat/utils/fetch';
import { isFunctionMessage } from '@/ProChat/utils/message';
import { setNamespace } from '@/ProChat/utils/storeDebug';
import { nanoid } from '@/ProChat/utils/uuid';
import { ChatMessage } from '@/types/message';
import { startTransition } from 'react';

import { initialModelConfig } from '@/ProChat/store/initialState';
import { ChatStreamPayload } from '@/ProChat/types/chat';
import { getSlicedMessagesWithConfig } from '../utils/message';
import { MessageDispatch, messagesReducer } from './reducers/message';
import { chatSelectors } from './selectors';

const t = setNamespace('chat/message');

interface FetchChatModelOptions {
  signal?: AbortSignal | undefined;
}

/**
 * 聊天操作
 */
export interface ChatAction {
  /**
   * 清除消息
   */
  clearMessage: () => void;

  /**
   * 删除消息
   * @param id - 消息 ID
   */
  deleteMessage: (id: string) => void;
  /**
   * 分发消息
   * @param payload - 消息分发参数
   */
  dispatchMessage: (payload: MessageDispatch) => void;
  /**
   * 生成消息
   * @param messages - 聊天消息数组
   * @param options - 获取 SSE 选项
   */
  generateMessage: (
    messages: ChatMessage[],
    assistantMessageId: string,
  ) => Promise<{ isFunctionCall: boolean }>;
  /**
   * 实际获取 AI 响应
   *
   * @param messages - 聊天消息数组
   * @param parentId - 父消息 ID，可选
   */
  realFetchAIResponse: (messages: ChatMessage[], parentId: string) => Promise<void>;

  /**
   * 重新发送消息
   * @param id - 消息 ID
   */
  resendMessage: (id: string) => Promise<void>;
  /**
   * 发送消息
   * @param text - 消息文本
   */
  sendMessage: (text: string) => Promise<void>;

  /**
   * 停止生成消息
   * @returns
   */
  stopGenerateMessage: () => void;

  /**
   * 切换 loading 状态
   * @param loading
   * @param id
   * @param action
   * @returns
   */
  toggleChatLoading: (
    loading: boolean,
    id?: string,
    action?: string,
  ) => AbortController | undefined;

  /**
   * 默认的数据请求方法
   * @param params
   * @param options
   * @returns
   */
  defaultModelFetcher: (
    params: Partial<ChatStreamPayload>,
    options?: FetchChatModelOptions,
  ) => Promise<Response>;

  /**
   * 生成消息 ID
   * @returns  消息 id
   */
  getMessageId: (messages: ChatMessage[], parentId: string) => Promise<string>;

  /**
   * 用于更新一条消息的内容（目前仅用于平滑输出时候，其余情况请直接使用 dispatchMessage ）
   */
  updateMessageContent: (id: string, content: string) => Promise<void>;

  /**
   * 获取当前 loading 生成的消息 id
   * @returns  消息 id ｜ undefined
   */
  getChatLoadingId: () => string | undefined;
}

export const chatAction: StateCreator<ChatStore, [['zustand/devtools', never]], [], ChatAction> = (
  set,
  get,
) => ({
  clearMessage: async () => {
    const { dispatchMessage, onResetMessage } = get();

    // 重置消息，清空聊天记录，等待 onResetMessage 完成后再清空
    if (onResetMessage) await onResetMessage();

    dispatchMessage({ type: 'resetMessages' });

    // TODO: need callback after reset
  },

  deleteMessage: (id) => {
    get().dispatchMessage({ id, type: 'deleteMessage' });
  },

  updateMessageContent: async (id, content) => {
    const { dispatchMessage, updateMessageContent } = get();
    dispatchMessage({ id, key: 'content', type: 'updateMessage', value: content });
    updateMessageContent(id, content);
  },

  dispatchMessage: (payload) => {
    const { chats, onChatsChange } = get();

    const nextChats = messagesReducer(chats, payload);

    set({ chats: nextChats }, false, t('dispatchMessage'));

    onChatsChange?.(nextChats);
  },
  generateMessage: async (messages, assistantId) => {
    const { dispatchMessage, toggleChatLoading, config, defaultModelFetcher } = get();

    const abortController = toggleChatLoading(
      true,
      assistantId,
      t('generateMessage(start)', { assistantId, messages }) as string,
    );

    // ========================== //
    //   对 messages 做统一预处理    //
    // ========================== //

    // 1. 按参数设定截断长度
    const slicedMessages = getSlicedMessagesWithConfig(messages, config);

    // 2. 替换 inputMessage 模板
    const compilerMessages = (slicedMessages: ChatMessage[]) => {
      const compiler = template(config.inputTemplate, { interpolate: /{{([\S\s]+?)}}/g });
      return slicedMessages.map((m) => {
        if (m.role === 'user') {
          try {
            return { ...m, content: compiler({ text: m.content }) };
          } catch (error) {
            console.error(error);

            return m;
          }
        }
        return m;
      });
    };
    const postMessages = !config.inputTemplate ? slicedMessages : compilerMessages(slicedMessages);

    // 3. 添加 systemRole
    if (config.systemRole) {
      postMessages.unshift({ content: config.systemRole, role: 'system' } as ChatMessage);
    }

    const fetcher = () =>
      defaultModelFetcher(
        {
          messages: postMessages,
          model: config.model,
          ...config.params,
        },
        { signal: abortController?.signal },
      );

    let output = '';
    let isFunctionCall = false;

    await fetchSSE(fetcher, {
      onErrorHandle: (error) => {
        dispatchMessage({ id: assistantId, key: 'error', type: 'updateMessage', value: error });
      },
      onMessageHandle: (text) => {
        output += text;
        if (!abortController.signal.aborted) {
          startTransition(() => {
            dispatchMessage({
              id: assistantId,
              key: 'content',
              type: 'updateMessage',
              value: output,
            });
          });
        } else {
          return;
        }

        // TODO: need a function call judge callback
        // 如果是 function call
        if (isFunctionMessage(output)) {
          isFunctionCall = true;
        }
      },
    });

    startTransition(() => {
      toggleChatLoading(false, undefined, t('generateMessage(end)') as string);
    });

    return { isFunctionCall };
  },

  realFetchAIResponse: async (messages, userMessageId) => {
    const { dispatchMessage, generateMessage, config, getMessageId } = get();

    // 添加一个空的信息用于放置 ai 响应，注意顺序不能反
    // 因为如果顺序反了，messages 中将包含新增的 ai message
    const mid = await getMessageId(messages, userMessageId);

    dispatchMessage({
      id: mid,
      message: LOADING_FLAT,
      parentId: userMessageId,
      role: 'assistant',
      type: 'addMessage',
    });

    // TODO: need a callback before generate message

    // 为模型添加 fromModel 的额外信息
    // TODO: 此处需要model 信息
    dispatchMessage({ id: mid, key: 'fromModel', type: 'updateMessageExtra', value: config.model });

    // 生成 ai message
    await generateMessage(messages, mid);

    // todo: need callback after generate message
  },

  resendMessage: async (messageId) => {
    // 1. 构造所有相关的历史记录
    const chats = chatSelectors.currentChats(get());

    const currentIndex = chats.findIndex((c) => c.id === messageId);
    if (currentIndex < 0) return;

    const currentMessage = chats[currentIndex];

    let contextMessages: ChatMessage[] = [];

    switch (currentMessage.role) {
      case 'function':
      case 'user': {
        contextMessages = chats.slice(0, currentIndex + 1);
        break;
      }
      case 'assistant': {
        // 消息是 AI 发出的因此需要找到它的 user 消息
        const userId = currentMessage.parentId;
        const userIndex = chats.findIndex((c) => c.id === userId);
        // 如果消息没有 parentId，那么同 user/function 模式
        contextMessages = chats.slice(0, userIndex < 0 ? currentIndex + 1 : userIndex + 1);
        break;
      }
    }

    if (contextMessages.length <= 0) return;

    const { realFetchAIResponse } = get();

    const latestMsg = contextMessages.filter((s) => s.role === 'user').at(-1);

    if (!latestMsg) return;

    await realFetchAIResponse(contextMessages, latestMsg.id);
  },

  sendMessage: async (message) => {
    const { dispatchMessage, realFetchAIResponse } = get();

    if (!message) return;

    const userId = nanoid();
    dispatchMessage({ id: userId, message, role: 'user', type: 'addMessage' });

    // Todo: need a callback before send message

    // Get the current messages to generate AI response
    const messages = chatSelectors.currentChats(get());

    await realFetchAIResponse(messages, userId);

    //   TODO: need a callback after send
  },

  stopGenerateMessage: () => {
    const { abortController, toggleChatLoading, chatLoadingId, chats, dispatchMessage } = get();
    // 如果当前 最后一条为 chatLoadingId 停止前需要清空
    if (chats && chats.length > 0) {
      const lastChat = chats[chats.length - 1];
      if (lastChat.content === LOADING_FLAT) {
        dispatchMessage({
          id: chatLoadingId,
          key: 'content',
          type: 'updateMessage',
          value: '',
        });
      }
    }

    if (!abortController) return;

    abortController.abort();

    toggleChatLoading(false);
  },
  toggleChatLoading: (loading, id, action) => {
    if (loading) {
      const abortController = new AbortController();
      set({ abortController, chatLoadingId: id }, false, action);
      return abortController;
    } else {
      set({ abortController: undefined, chatLoadingId: undefined }, false, action);
    }
  },

  defaultModelFetcher: (params, options) => {
    const { request } = get();
    const payload = merge(
      {
        model: initialModelConfig.model,
        stream: true,
        ...initialModelConfig.params,
      },
      params,
    );

    if (typeof request === 'function')
      return request(payload.messages as ChatMessage[], payload, options?.signal);

    const url = typeof request === 'string' ? request : '/api/openai/chat';

    return fetch(url, {
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      signal: options?.signal,
    });
  },
  getMessageId: async (messages, parentId) => {
    const { genMessageId } = get();
    if (typeof genMessageId === 'function') return genMessageId(messages, parentId);
    return nanoid();
  },

  getChatLoadingId: () => {
    const { chatLoadingId } = get();
    return chatLoadingId;
  },
});
