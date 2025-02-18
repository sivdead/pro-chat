import ChatList, { ChatListProps } from '@/ChatList';
import isEqual from 'fast-deep-equal';
import { memo, useMemo } from 'react';

import { useStore } from '@/ProChat/store';
import { chatSelectors } from '@/ProChat/store/selectors';

import { ChatListItemProps } from '@/ChatList/ChatListItem';
import { useRefFunction } from '@/ProChat/hooks/useRefFunction';
import { renderActions } from './Actions';
import { renderMessagesExtra } from './Extras';
import { renderMessages } from './Messages';
import SkeletonList from './SkeletonList';

interface ListProps extends Partial<ChatListProps> {
  showTitle?: boolean;
  itemShouldUpdate?: (prevProps: ChatListItemProps, nextProps: ChatListItemProps) => boolean;
}

const List = memo<ListProps>(({ showTitle, itemShouldUpdate, chatItemRenderConfig }) => {
  const data = useStore(chatSelectors.currentChatsWithGuideMessage, isEqual);

  const [
    init,
    displayMode,
    enableHistoryCount,
    historyCount,
    chatLoadingId,
    deleteMessage,
    resendMessage,
    dispatchMessage,
  ] = useStore((s) => {
    const config = s.config;

    return [
      s.init,
      s.displayMode,
      config.enableHistoryCount,
      config.historyCount,
      s.chatLoadingId,
      s.deleteMessage,
      s.resendMessage,
      s.dispatchMessage,
    ];
  });

  const onActionsClick = useRefFunction((action, { id, error }) => {
    switch (action.key) {
      case 'del': {
        deleteMessage(id);
        break;
      }
      case 'regenerate': {
        resendMessage(id);

        // if this message is an error message, we need to delete it
        if (error) deleteMessage(id);
        break;
      }
    }

    // TODO: need a custom callback
  });

  const onMessageChange = useRefFunction((id, content) =>
    dispatchMessage({ id, key: 'content', type: 'updateMessage', value: content }),
  );

  const textObj = useMemo(() => {
    return {
      cancel: '取消',
      confirm: '确认',
      copy: '复制',
      copySuccess: '复制成功',
      delete: '删除',
      edit: '编辑',
      history: '历史范围',
      regenerate: '重新生成',
    };
  }, []);
  if (!init) return <SkeletonList />;

  return (
    <ChatList
      showTitle={showTitle}
      data={data}
      itemShouldUpdate={itemShouldUpdate}
      enableHistoryCount={enableHistoryCount}
      historyCount={historyCount}
      loadingId={chatLoadingId}
      onActionsClick={onActionsClick}
      onMessageChange={onMessageChange}
      renderActions={renderActions}
      // need support custom Render
      renderMessages={renderMessages}
      renderMessagesExtra={renderMessagesExtra}
      style={{ marginTop: 24 }}
      chatItemRenderConfig={chatItemRenderConfig}
      text={textObj}
      type={displayMode || 'chat'}
    />
  );
});

export default List;
