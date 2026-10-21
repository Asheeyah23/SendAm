import { Pressable, ScrollView, Text, View } from 'react-native';

/**
 * Normalize a WhatsApp interactive list message out of a bot message, or
 * return null when the message isn't one.
 *
 * Accepted shapes, in order:
 *   - `message.interactive` — the WhatsApp Cloud API payload:
 *     `{ type: 'list', body: { text }, action: { button, sections } }`
 *   - `message.listMessage` — the same thing minus the Cloud API nesting:
 *     `{ body, buttonLabel, sections }`
 *   - `message.text` that *is* one of the above as a JSON string. The sim
 *     pipeline only carries reply strings (see sim.controller.js), so this is
 *     how a list message actually travels through the simulator today.
 *
 * The result is `{ body, buttonLabel, sections: [{ id, title, rows }] }` with
 * every row shaped `{ id, title, description }`. Sections without usable rows
 * are dropped; a list with no rows left is not a list message.
 */
export function parseListMessage(message) {
  if (!message || message.sender !== 'bot') return null;

  let source = null;
  if (message.interactive && typeof message.interactive === 'object') {
    source = message.interactive;
  } else if (message.listMessage && typeof message.listMessage === 'object') {
    source = { type: 'list', ...message.listMessage };
  } else {
    const text = String(message.text || '').trim();
    if (text.startsWith('{') && text.includes('sections')) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
          source = parsed.interactive && typeof parsed.interactive === 'object'
            ? parsed.interactive
            : parsed;
        }
      } catch {
        return null;
      }
    }
  }
  if (!source || (source.type && source.type !== 'list')) return null;

  const action = source.action && typeof source.action === 'object' ? source.action : source;
  const rawSections = Array.isArray(action.sections) ? action.sections : [];
  const sections = rawSections
    .map((section, sectionIndex) => ({
      id: `section-${sectionIndex}`,
      title: typeof section?.title === 'string' ? section.title : '',
      rows: (Array.isArray(section?.rows) ? section.rows : [])
        .map((row, rowIndex) => ({
          id: String(row?.id || `row-${sectionIndex}-${rowIndex}`),
          title: typeof row?.title === 'string' ? row.title : '',
          description: typeof row?.description === 'string' ? row.description : '',
        }))
        .filter((row) => row.title),
    }))
    .filter((section) => section.rows.length > 0);
  if (sections.length === 0) return null;

  const bodyText =
    typeof source.body === 'string' ? source.body : source.body?.text;
  return {
    body: typeof bodyText === 'string' ? bodyText : '',
    buttonLabel:
      (typeof action.button === 'string' && action.button) ||
      (typeof source.buttonLabel === 'string' && source.buttonLabel) ||
      'Menu',
    sections,
  };
}

export function parseQuickReplies(message) {
  if (!message || message.sender !== 'bot') return [];
  if (Array.isArray(message.quickReplies) && message.quickReplies.length > 0) {
    return message.quickReplies.map((r, i) => {
      if (typeof r === 'string') return { id: `qr-${i}`, label: r, payload: r };
      return {
        id: r.id || `qr-${i}`,
        label: r.label || r.text || String(r),
        payload: r.payload || r.text || r.label || String(r),
      };
    });
  }
  if (Array.isArray(message.options) && message.options.length > 0) {
    return message.options.map((opt, i) => {
      if (typeof opt === 'string') return { id: `opt-${i}`, label: opt, payload: opt };
      return {
        id: opt.id || `opt-${i}`,
        label: opt.label || opt.text || String(opt),
        payload: opt.payload || opt.text || opt.label || String(opt),
      };
    });
  }
  const text = String(message.text || '');
  const replies = [];

  // Match numbered/listed options, e.g. "1: Check Balance", "2. Send Money", "1) Check Balance", "[1] Check Balance"
  const optionRegex = /(?:^|\n)\s*(?:\[?(\d+)\]?[\.:\)\-]\s+([^\n\r]+))/g;
  let match;
  while ((match = optionRegex.exec(text)) !== null) {
    const rawNum = match[1];
    const rawLabel = match[2].trim();
    replies.push({
      id: `num-${rawNum}`,
      label: `${rawNum}: ${rawLabel}`,
      payload: `${rawNum}: ${rawLabel}`,
    });
  }

  // Also check for yes/no confirmation prompts, e.g. Reply "YES" to confirm, or "NO" to cancel.
  if (replies.length === 0) {
    const yesNoMatch = text.match(/reply\s+["']?(yes)["']?\s+to\s+confirm(?:ing)?(?:,\s*or\s*["']?(no)["']?\s+to\s+cancel)?/i);
    if (yesNoMatch) {
      replies.push({ id: 'opt-yes', label: 'YES', payload: 'YES' });
      if (yesNoMatch[2] || /cancel/i.test(text)) {
        replies.push({ id: 'opt-no', label: 'NO', payload: 'NO' });
      }
    }
  }

  return replies;
}

export default function MessageList({
  messages,
  onQuickReply,
  onOpenList,
  disabledReplies = {},
  sending = false,
}) {
  return (
    <ScrollView contentContainerClassName="px-3 py-2 gap-2">
      {messages.map((item) => {
        const isUser = item.sender === 'user';
        const listMessage = !isUser ? parseListMessage(item) : null;
        // A list message's text is its payload, not a menu to regex-scan.
        const quickReplies = !isUser && !listMessage ? parseQuickReplies(item) : [];
        const isMsgDisabled = Boolean(disabledReplies[item.id]) || sending;

        return (
          <View key={item.id} className="gap-1.5">
            <View
              testID={`bubble-${item.sender}`}
              className={
                isUser
                  ? 'self-end bg-green-500 rounded-2xl px-3 py-2 max-w-[80%]'
                  : 'self-start bg-gray-200 rounded-2xl px-3 py-2 max-w-[80%]'
              }
            >
              {listMessage ? (
                <View className="gap-1.5">
                  <Text className="text-gray-900">
                    {listMessage.body || 'Choose an option'}
                  </Text>
                  <View className="border-t border-gray-300" />
                  <Pressable
                    testID={`list-message-button-${item.id}`}
                    accessibilityRole="button"
                    disabled={isMsgDisabled}
                    onPress={() => onOpenList && onOpenList(listMessage, item.id)}
                    className={`flex-row items-center justify-center gap-1.5 py-1 ${
                      isMsgDisabled ? 'opacity-50' : 'active:opacity-70'
                    }`}
                  >
                    <Text className="text-sm font-semibold text-sky-600">
                      ☰ {listMessage.buttonLabel}
                    </Text>
                  </Pressable>
                </View>
              ) : (
                <Text className={isUser ? 'text-white' : 'text-gray-900'}>{item.text}</Text>
              )}
            </View>

            {/* WhatsApp interactive quick-reply pill buttons */}
            {quickReplies.length > 0 && (
              <View
                testID="quick-replies-container"
                className="flex-row flex-wrap gap-2 mt-1 self-start max-w-[90%]"
              >
                {quickReplies.map((reply, idx) => {
                  const isSelected = disabledReplies[item.id] === reply.payload;
                  return (
                    <Pressable
                      key={reply.id || idx}
                      testID={`quick-reply-${idx}`}
                      accessibilityRole="button"
                      disabled={isMsgDisabled}
                      onPress={() => onQuickReply && onQuickReply(reply.payload, item.id)}
                      className={`px-3 py-1.5 rounded-full border shadow-sm ${
                        isMsgDisabled
                          ? isSelected
                            ? 'bg-emerald-600 border-emerald-700 opacity-90'
                            : 'bg-gray-100 border-gray-300 opacity-50'
                          : 'bg-emerald-50 border-emerald-500 active:bg-emerald-100'
                      }`}
                    >
                      <Text
                        className={`text-xs font-semibold ${
                          isMsgDisabled
                            ? isSelected
                              ? 'text-white'
                              : 'text-gray-400'
                            : 'text-emerald-700'
                        }`}
                      >
                        {reply.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>
        );
      })}
    </ScrollView>
  );
}

